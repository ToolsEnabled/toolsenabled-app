// Slash commands for the agent console — client-side sugar over actions that
// already exist. The parser maps `/word` onto the SAME palette action ids the
// Actions page binds (src/views/computers.js runPaletteAction), so a command
// can never name something the buttons cannot do. Commands for capabilities
// that arrive in later phases (/model, /attach, /clear, /rewind) join HERE in
// the phase that makes each real — never before.
//
// A message that merely starts with "/" is not swallowed: only `/word` where
// word is a KNOWN command is intercepted; an unknown `/word` gets a sentence
// naming the real ones and is NOT sent (mis-typing /interupt should not send
// the typo to the agent); anything path-shaped (a second "/", a drive colon,
// or no letters) sends as ordinary text.

/* The one sentence a refused queue-edit shows. Imported rather than written
   here for the reason src/chat-copy.js's header gives: a sentence at its use
   site is the one that escapes the plain-language gate. */
import { QUEUE_PANEL } from './fleet-tree-copy.js'
import { LOOP_BOUNDS } from './agent-loops.js'
import { parseCloudCommand } from '../shell/cloud-command.mjs'

export const SLASH_COMMANDS = Object.freeze([
  Object.freeze({ name: 'interrupt', action: 'interrupt', help: 'stop the current turn; the agent keeps its memory' }),
  Object.freeze({ name: 'stop', action: 'stop', help: 'end this agent\'s session' }),
  Object.freeze({ name: 'queue', action: 'queue', help: 'queue the words after the command for when the agent is free' }),
  Object.freeze({ name: 'move', action: 'move', help: 'change who this agent reports to' }),
  Object.freeze({ name: 'copy', action: 'copy-reply', help: 'copy the last reply' }),
  Object.freeze({ name: 'model', action: 'switch-model', help: 'pick the model the next message runs on' }),
  Object.freeze({ name: 'attach', action: 'attach', help: 'attach an image to the next message' }),
  Object.freeze({ name: 'mention', action: 'mention', help: 'pick a file and write its path into the message' }),
  Object.freeze({ name: 'clear', action: 'clear', help: 'start this conversation over; the agent forgets everything said here' }),
  Object.freeze({ name: 'rewind', action: 'rewind', help: 'go back to one of your messages; the agent forgets everything after it' }),
])

const BY_NAME = new Map(SLASH_COMMANDS.map(command => [command.name, command]))

/* THE /REQUEST FAMILY — the owner's standing rules, typed where the person is
 * already talking. These are NOT palette actions: nothing on the Actions page
 * files a rule, so they carry a scope instead of an action id and the view
 * routes kind:'request' to the product's own filing seam. The engine's
 * r-ledger module (owner design 2026-08-15) is the ground truth for the four
 * scopes; the words after the command are the rule, verbatim.
 *
 * `word` is what the parser's lowercasing produces; `spoken` is how the
 * command is written everywhere a person reads it. */
export const REQUEST_COMMANDS = Object.freeze([
  Object.freeze({ word: 'request', spoken: '/Request', scope: 'global' }),
  Object.freeze({ word: 'requestsession', spoken: '/RequestSession', scope: 'session' }),
  Object.freeze({ word: 'requesttree', spoken: '/RequestTree', scope: 'tree' }),
  Object.freeze({ word: 'requestthread', spoken: '/RequestThread', scope: 'thread' }),
])

const REQUEST_BY_WORD = new Map(REQUEST_COMMANDS.map(command => [command.word, command]))
const REQUEST_BY_SCOPE = new Map(REQUEST_COMMANDS.map(command => [command.scope, command]))

/* THE /TASK FAMILY — built the same way as /Request, for the ledger's T
 * subset (owner, 2026-09-06: "T for tasks, these can be recurring loop tasks
 * or tasks that have a definitve completion - these tasks can be completed
 * and removed by agents"). Same four scopes, same grammar; the words after
 * the command are the task, verbatim. Whether a filed task is one-shot or
 * recurring is not said in the command line — that is the task's own
 * lifecycle, set where it is completed or scheduled, not typed here. */
export const TASK_COMMANDS = Object.freeze([
  Object.freeze({ word: 'task', spoken: '/Task', scope: 'global' }),
  Object.freeze({ word: 'tasksession', spoken: '/TaskSession', scope: 'session' }),
  Object.freeze({ word: 'tasktree', spoken: '/TaskTree', scope: 'tree' }),
  Object.freeze({ word: 'taskthread', spoken: '/TaskThread', scope: 'thread' }),
])

const TASK_BY_WORD = new Map(TASK_COMMANDS.map(command => [command.word, command]))
const TASK_BY_SCOPE = new Map(TASK_COMMANDS.map(command => [command.scope, command]))

/* THE /ASK FAMILY — built the same way as /Request, for the ledger's A
 * subset (owner, 2026-09-06: "Asks for things agents need from the owner").
 * Same four scopes, same grammar; the words after the command are the
 * question, verbatim. */
export const ASK_COMMANDS = Object.freeze([
  Object.freeze({ word: 'ask', spoken: '/Ask', scope: 'global' }),
  Object.freeze({ word: 'asksession', spoken: '/AskSession', scope: 'session' }),
  Object.freeze({ word: 'asktree', spoken: '/AskTree', scope: 'tree' }),
  Object.freeze({ word: 'askthread', spoken: '/AskThread', scope: 'thread' }),
])

const ASK_BY_WORD = new Map(ASK_COMMANDS.map(command => [command.word, command]))
const ASK_BY_SCOPE = new Map(ASK_COMMANDS.map(command => [command.scope, command]))

/* A GOAL IS AN AGENT COMMAND, AND -- WHEN AN R ID IS TYPED -- ALSO A QUEUE
 * RECORD.
 *
 * WHAT THIS USED TO SAY, AND WHY IT IS WRONG. The note here read "A GOAL IS A
 * QUEUE RECORD, NOT AN AGENT COMMAND", and the usage sentence below told a
 * person "Nothing was recorded and no agent was started." That is the defect
 * the owner reported as "theres still issues with goal": ledger T61, owner
 * A23, overruling the record-only closure of T48 -- "a goal set in the app
 * makes the agent work autonomously until the goal is achieved. It is NOT
 * record-only." Typing what you want done and getting a queue row and an idle
 * agent is not a goal.
 *
 * SO `/goal <objective>` NOW SETS A GOAL ON THE RUNNING AGENT, and the R id
 * became OPTIONAL rather than required. The queue write did not go away: it
 * was working, nobody asked for it to stop, and removing it would take a
 * durable build-queue record away from a person who typed the same words they
 * always did. `/goal R1234 <objective>` therefore does both -- records the
 * item AND sets the goal -- and `/goal <objective>` sets the goal alone.
 *
 * The R id must still be typed by the person and must already be in the
 * canonical ledger form. In particular, only the command word is
 * case-insensitive: accepting `r1234`, extracting an R-looking token from the
 * objective, or supplying a recent request would all invent authority the
 * person did not give that write.
 *
 * This is the same canonical R-family grammar as the engine's request-id
 * module: R1..R9999, its historical R00..R09 range, and explicit non-zero
 * version components. Keeping the expression here makes malformed input fail
 * before any bridge read or write. */
export const GOAL_REQUEST_ID_RE = /^R(?:0\d|[1-9]\d{0,3})(?:\.[1-9]\d*)*$/

/* The bridge allows a 2 KiB single-line title. Ninety-six Unicode code points
 * are at most 384 UTF-8 bytes, plus the ellipsis, so even an all-four-byte
 * objective stays comfortably inside that engine bound. The brief remains the
 * exact parsed objective; only this display title is folded and shortened. */
export const GOAL_TITLE_MAX_CODE_POINTS = 96
export const GOAL_BRIEF_MAX_BYTES = 16 * 1024

/* THE BOUND ON AN OBJECTIVE THAT WILL BE SET AS A GOAL. ONE NUMBER, NOT TWO.
 *
 * `/goal R1234 <objective>` does two things with the SAME typed words: it
 * opens a queue item and it sets a goal. An earlier draft of this gave the
 * goal half a tighter 8 KB bound, on the reasoning that a brief is written to
 * disk once while an objective rides into model context on every turn. That
 * reasoning is sound about cost and wrong about product: it would refuse the
 * goal for a 12 KB objective the queue would happily have taken, so one typed
 * string would half-work with no way for the person to see why. Two bounds on
 * one input is the same "two answers that can disagree" this file avoids
 * everywhere else, so the goal takes the queue's bound.
 *
 * Same number as GOAL_MAX_OBJECTIVE_BYTES in shell/session-goal.cjs, which is
 * the host's own bound on the same value -- two modules because the renderer
 * is ESM and the host is CJS and this package shares nothing between them.
 * Refusing here means a person is told before the send rather than after it;
 * the host's bound is the backstop. */
export const GOAL_OBJECTIVE_MAX_BYTES = GOAL_BRIEF_MAX_BYTES

export function goalTitleFromObjective(objective) {
  const oneLine = typeof objective === 'string' ? objective.replace(/\s+/g, ' ').trim() : ''
  const points = Array.from(oneLine)
  if (points.length <= GOAL_TITLE_MAX_CODE_POINTS) return oneLine
  return `${points.slice(0, GOAL_TITLE_MAX_CODE_POINTS - 1).join('')}\u2026`
}

export function goalUsageSentence() {
  return 'No goal was set. Type /goal followed by what you want done, and this agent will keep working toward it on its own. Add an existing request ID first — /goal R1234 <objective> — to also record a build-queue item. /goal on its own shows the current goal; /goal clear clears it.'
}

/* The queue half of a `/goal R1234 …`. It no longer says "No agent was
   started", because one now is: saying so would be the same untruth in the
   opposite direction. What the AGENT is doing is reported separately, by the
   goal itself, so this sentence stays about the queue and nothing else. */
export function goalConfirmationSentence(phaseId, directiveId) {
  return `Recorded ${phaseId} in the build queue under ${directiveId}.`
}

export function goalPendingSentence() {
  return 'Setting the goal.'
}

export function goalTooLongSentence() {
  return 'No goal was set. The objective is longer than the 8 KB a goal may carry; shorten it and try again.'
}

/* WHAT A PERSON IS TOLD WHEN THERE IS NO AGENT TO SET A GOAL ON.
   Acceptance point 1 of T61: "If no session is running the refusal says so
   plainly." Plainly means naming the thing they have to do, not the state
   the code is in. */
export function goalNoSessionSentence() {
  return 'No goal was set: this agent is not running, so there is nothing to work toward the goal. Start it first, then set the goal.'
}

export function goalSetPendingSentence() {
  return 'Setting the goal on this agent.'
}

/* A write can finish and then lose its response, so post-write failures must
 * not claim "nothing was recorded" or tell the person to retry blindly. Only
 * preflight refusals use that stronger sentence. No bridge reason, path, code,
 * hash, or objective is reflected into these product notes. */
/* THESE ARE NOW ABOUT THE QUEUE HALF ONLY, and they stopped saying "no agent
   was started". A `/goal R1234 …` does two independent things, and the queue
   write failing does not mean the goal failed -- they are reported
   separately, because a person told "nothing happened" when their agent is in
   fact working toward the goal would be told the most misleading thing this
   screen can say. */
const GOAL_REFUSALS = Object.freeze({
  disabled: 'The build-queue item was not recorded: build-queue changes are switched off in Settings; turn on "Take or finish queued work" and try again.',
  unavailable: 'The build-queue item was not recorded: the build queue is not ready on this computer right now.',
  unconfirmed: 'This screen could not confirm whether the build-queue item was recorded; check the build queue before trying again.',
  noSession: 'No goal was set: this agent is not running, so there is nothing to work toward the goal. Start it first, then set the goal.',
  goalUnconfirmed: 'This screen could not confirm the goal was set. Type /goal on its own to see whether it took.',
})

export function goalRefusalSentence(reason) {
  return GOAL_REFUSALS[reason] || GOAL_REFUSALS.unconfirmed
}

/* WHO A FILED RULE REACHES, said the same way everywhere. The four scopes are
 * the thing a person will get wrong, so every sentence about a filed rule
 * must state its reach — a confirmation that just says "filed" teaches
 * nothing and lets a thread rule be mistaken for a global one. */
const REQUEST_SCOPE_REACH = Object.freeze({
  global: 'every agent on this computer, until you edit or delete it',
  session: 'this working session and every agent it starts',
  tree: 'this agent and every agent working under it',
  thread: 'this conversation only — every future session of it starts knowing the rule',
})

/** One sentence: nothing was filed, and how to say it so something is. */
export function requestUsageSentence(scope) {
  const command = REQUEST_BY_SCOPE.get(scope)
  const spoken = command ? command.spoken : '/Request'
  return `Nothing was filed — say the rule after the command, like ${spoken} <your words>.`
}

/** The one-sentence confirmation the chat shows after the product files a rule. */
export function requestConfirmationSentence(scope, id) {
  return `Filed ${id} — a standing rule for ${REQUEST_SCOPE_REACH[scope] || scope}.`
}

/** One sentence: nothing was filed, and how to say it so something is. */
export function taskUsageSentence(scope) {
  const command = TASK_BY_SCOPE.get(scope)
  const spoken = command ? command.spoken : '/Task'
  return `Nothing was filed — say the task after the command, like ${spoken} <your words>.`
}

/* WHO A FILED TASK IS OPEN TO. A task is not a standing rule: it is done
   once and then completed or deleted, and there is no Edit for it anywhere,
   so its sentence neither promises an edit nor calls it a rule (T1266). */
const TASK_SCOPE_REACH = Object.freeze({
  global: 'open to every agent on this computer',
  session: 'open to this working session and every agent it starts',
  tree: 'open to this agent and every agent working under it',
  thread: 'for this conversation only',
})

/** The one-sentence confirmation the chat shows after the product files a task. */
export function taskConfirmationSentence(scope, id) {
  return `Filed ${id} — a task ${TASK_SCOPE_REACH[scope] || `for ${scope}`}; mark it complete or delete it on the Ledger page.`
}

/** One sentence: nothing was filed, and how to say it so something is. */
export function askUsageSentence(scope) {
  const command = ASK_BY_SCOPE.get(scope)
  const spoken = command ? command.spoken : '/Ask'
  return `Nothing was filed — say what you need after the command, like ${spoken} <your words>.`
}

/** The one-sentence confirmation the chat shows after the product files a question for the owner. */
export function askConfirmationSentence(scope, id) {
  return `Filed ${id} — a question for ${REQUEST_SCOPE_REACH[scope] || scope}.`
}

export function slashHelpSentence() {
  return `Common functions: /goal <objective> and /loop [minutes]. Use /cloud <request> to have this agent manage a cloud swarm, or /cloud alone for the current objective. Optional worker limits are in Actions › Cloud swarm. Set a goal with /goal <objective> and this agent keeps working toward it on its own. It stops when it reports the goal achieved, when you clear it with /goal clear, or when you press Stop. Typing /goal on its own shows the current goal. Add an existing request ID, /goal R1234 <objective>, to also record a build-queue item. Open Loop setup with /loop, or /loop 5 for five minutes between runs. Commands here: ${SLASH_COMMANDS.map(command => `/${command.name}`).join(', ')} and /help. File a standing rule with /Request, /RequestSession, /RequestTree, or /RequestThread. File a task with /Task, /TaskSession, /TaskTree, or /TaskThread. Ask the owner something with /Ask, /AskSession, /AskTree, or /AskThread. Everything else sends as a message.`
}

export function loopUsageSentence() {
  return 'Use /loop to open Loop setup, or /loop 5 to set five minutes between runs. Choose a whole number from 1 to 240 minutes. Nothing starts until you press Start loop.'
}

/**
 * Parse a console input line.
 * Returns null when the text should send as an ordinary message;
 * { kind: 'action', action, rest } for a known command;
 * { kind: 'request', scope, rest } for the /Request family;
 * { kind: 'task', scope, rest } for the /Task family;
 * { kind: 'ask', scope, rest } for the /Ask family;
 * { kind: 'goal', directiveId, objective } for a valid record-only goal;
 * { kind: 'loop', minutes } to open Loop setup, with an optional interval;
 * { kind: 'help', sentence } for /help;
 * { kind: 'unknown', sentence } for an unknown /word (NOT sent).
 */
export function parseSlashCommand(text) {
  const cloud = parseCloudCommand(text)
  if (cloud) return cloud
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  const match = /^\/([A-Za-z][A-Za-z-]*)(?:\s+([\s\S]*))?$/.exec(trimmed)
  if (!match) return null
  const word = match[1].toLowerCase()
  const rest = (match[2] || '').trim()
  if (word === 'help') return { kind: 'help', sentence: slashHelpSentence() }
  if (word === 'loop') {
    if (!rest) return { kind: 'loop', minutes: null }
    const interval = /^(\d+)\s*(?:m|min|minutes?)?$/i.exec(rest)
    const minutes = interval ? Number(interval[1]) : NaN
    if (!Number.isInteger(minutes) || minutes * 60_000 < LOOP_BOUNDS.minIntervalMs || minutes * 60_000 > LOOP_BOUNDS.maxIntervalMs) {
      return { kind: 'loop', sentence: loopUsageSentence() }
    }
    return { kind: 'loop', minutes }
  }
  const command = BY_NAME.get(word)
  if (command) return { kind: 'action', action: command.action, rest }
  const request = REQUEST_BY_WORD.get(word)
  if (request) return { kind: 'request', scope: request.scope, rest }
  const taskCommand = TASK_BY_WORD.get(word)
  if (taskCommand) return { kind: 'task', scope: taskCommand.scope, rest }
  const askCommand = ASK_BY_WORD.get(word)
  if (askCommand) return { kind: 'ask', scope: askCommand.scope, rest }
  /* `/goal` SETS A GOAL ON THE RUNNING AGENT. See the block above
     GOAL_REQUEST_ID_RE for what changed here and why the queue write stayed.

     Three shapes, decided in this order, because the first two are exact
     words and the third is free text that could contain them:
       /goal                 -> show the goal that is set
       /goal clear           -> clear it
       /goal [R1234] <words> -> set it (and record the queue item, if an R id
                                was typed) */
  if (word === 'goal') {
    if (!rest) return { kind: 'goal', operation: 'show' }
    if (/^clear$/i.test(rest)) return { kind: 'goal', operation: 'clear' }
    /* AN R ID IS NOW OPTIONAL AND IS STILL NEVER INVENTED. The same canonical
       form as before, read only off the FIRST word and only when the person
       typed it there; anything else is objective text. A `/goal R1234 ...`
       that used to open a queue item still opens one -- the queue write was
       working and T61 did not ask for it to stop -- and now also sets the
       goal, which is the half that was missing. */
    const withId = /^(\S+)\s+([\s\S]+)$/.exec(rest)
    const directiveId = withId && GOAL_REQUEST_ID_RE.test(withId[1]) ? withId[1] : null
    const objective = (directiveId ? withId[2] : rest).trim()
    if (!objective) return { kind: 'goal', sentence: goalUsageSentence() }
    if (new TextEncoder().encode(objective).byteLength > GOAL_OBJECTIVE_MAX_BYTES) {
      return { kind: 'goal', sentence: goalTooLongSentence() }
    }
    return { kind: 'goal', operation: 'set', directiveId, objective }
  }
  /* Path-shaped input ("/usr/bin/thing" fails the regex on the second slash
     already); a lone unknown word is most likely a typo of a command. */
  return {
    kind: 'unknown',
    sentence: `“/${word}” is not a command here, so nothing was sent. ${slashHelpSentence()}`,
  }
}

/* REWRITING A WAITING MESSAGE INTO A COMMAND IS REFUSED, BY NAME.
 *
 * The up-arrow walk (src/composer-queue-recall.js) is the third way words
 * reach the session outbox, and the first two both parse commands before
 * anything is stored: treeCardSend on the idle path and the busy composer's
 * `queue.add`, in src/views/computers.js. That parse is not cosmetic. A queued
 * message is DRAINED STRAIGHT TO THE MODEL when the turn ends, so `/goal`,
 * `/RequestThread` or `/interrupt` written into a waiting message would arrive
 * at the agent as ordinary text with every check those words are supposed to
 * pass through skipped -- an audited ledger write becoming a sentence in a
 * prompt, an interrupt becoming a request the model may or may not honour.
 *
 * The answer is a refusal with a sentence, not a silent rewrite into something
 * else: the person keeps Unqueue and an empty composer, which is the path that
 * parses. It lives here, beside the parser it depends on, so it can be driven
 * with values -- the view that calls it needs a whole DOM to load.
 *
 * Returns the sentence to show, or null when the text is an ordinary message.
 */
export function queuedMessageEditRefusal(text) {
  const command = parseSlashCommand(text)
  // Cloud is a host-interpreted agent request, including on an outbox drain.
  // Product-only commands still must go through the immediate console route.
  return command && (command.kind !== 'cloud' || command.sentence) ? QUEUE_PANEL.commandNotAWaitingMessage : null
}
