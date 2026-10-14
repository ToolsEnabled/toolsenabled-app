'use strict';

/* A GOAL, AND WHY IT IS HOST-DRIVEN RATHER THAN ASKED OF THE PROVIDER.
 *
 * T61 (owner A23, overruling the record-only closure of T48): "a goal set in
 * the app makes the agent work autonomously until the goal is achieved". The
 * owner's own report on the cut-1 build was "theres still issues with goal".
 *
 * THE DESIGN QUESTION THIS FILE ANSWERS. Codex 0.154 has a native persisted
 * thread-goal (set/get/clear) and the obvious build is to call it. The
 * previous lane built exactly that, and its own session gate reads
 * "This agent provider does not support native goals. Use a Codex agent."
 * The owner runs CLAUDE workers. A goal that only works on one provider is
 * not the feature that was asked for, so the native API is not the mechanism
 * here: it cannot be, because on the tier the owner actually uses there is
 * nothing to call.
 *
 * So a goal is state THIS HOST owns, and a continuation is an ordinary turn
 * this host sends. That buys three things no native API offered:
 *
 *   1. It works on every provider the app can start, because it asks the
 *      provider for nothing it does not already do -- accept a turn.
 *   2. The continuation goes through sendTurn(), the SAME path a person's
 *      message takes. That path recomputes the standing-rules block, the tree
 *      identity and the role introduction on every turn regardless of origin
 *      (see agent-host.cjs, `currentRequestsSnapshot` / `requestsIntroduction`).
 *      A self-started turn therefore carries the CURRENT Ledger rules. The
 *      previous lane recorded this as unsolvable -- "no supported native hook"
 *      -- and it is unsolvable natively, because a provider continuing a turn
 *      on its own never re-enters the app's send path. It is free here.
 *   3. Stop, overlap and the one-turn-at-a-time rule stay exactly where they
 *      already are, because a continuation is not special.
 *
 * WHAT THIS FILE IS. Pure functions and constants: no I/O, no session, no
 * timers, no Electron. Everything here can be called with values, which is
 * how tools/test/session-goal.test.mjs tests it.
 *
 * HOW AN AGENT SAYS IT IS DONE, WITHOUT A PROVIDER API TO SAY IT WITH. The
 * instruction block below asks for a marker line, and the host reads the
 * marker off the assistant's own text. The marker must be the WHOLE of the
 * last non-empty line: an agent that mentions the marker while explaining
 * what it will do later ("I will write [[GOAL-ACHIEVED]] when the tests
 * pass") has not finished, and reading a marker out of the middle of a
 * sentence would end the goal on the sentence that promised to continue.
 * That is the difference between a goal that stops when the work is done and
 * one that stops when the agent talks about being done.
 */

/* The objective a person may set. This is the SAME number as
   GOAL_BRIEF_MAX_BYTES in src/slash-commands.js -- the bound the build-queue
   brief already had -- because `/goal R1234 <objective>` sets a goal and opens
   a queue item from one typed string, and a string that is short enough for
   one half but not the other would half-work with nothing on screen saying
   why. Restated rather than imported: the renderer is ESM, this is CJS, and
   this package shares no module between them. The renderer refuses first so
   the person is told before the send; this is the backstop. */
const GOAL_MAX_OBJECTIVE_BYTES = 16 * 1024;

/* Goal semantics are completion-driven. A person who sets /goal has asked
 * the host to keep sending ordinary turns until the provider reports achieved,
 * the provider is blocked, a turn fails/refuses, Stop/Clear intervenes, or a
 * separate account/admission/resource/delivery guard refuses it. The host does
 * not add a second Goal-only iteration budget here: Loop's selected run count
 * belongs to Loop, not Goal. */

const GOAL_ACHIEVED_MARKER = '[[GOAL-ACHIEVED]]';
const GOAL_BLOCKED_MARKER = '[[GOAL-BLOCKED]]';

/* `active` runs continuations. `paused` keeps the objective and starts
   nothing -- what Stop, a failed/refused turn, or an explicit pause leaves
   behind. `achieved` and `blocked` are the agent's own terminal answers.
   A cleared goal is not a status: it is the absence of a goal (null). */
const GOAL_STATUSES = Object.freeze(['active', 'paused', 'achieved', 'blocked']);

/* The statuses that mean "this host should be starting turns". */
const GOAL_RUNNING_STATUSES = Object.freeze(['active']);

/* HOW A TURN HAS TO HAVE ENDED BEFORE ANOTHER ONE IS STARTED ON ITS HEELS.
 *
 * The same three the landed ledger continuation accepts (SUCCESS_STATUSES in
 * the engine's ledger-continuation-controller.js): 'completed' and 'success'
 * from the Claude CLI and the local adapter, 'end_turn' from the raw ACP
 * stopReason a real ACP turn ends with. Restated here rather than imported
 * because that module ships in the generated capability payload and can be
 * absent, and a goal must not stop working because the engine payload is
 * thin. If the two ever disagree the engine's list is the fact.
 *
 * A turn that FAILED pauses the goal instead of being retried. A person who
 * set a goal and walked away is precisely the person who must not come back
 * to repeated failed turns billed at provider rates; the objective is kept so
 * they can resume it once they know why. */
const GOAL_TURN_SUCCESS_STATUSES = Object.freeze(['completed', 'end_turn', 'success']);

function goalTurnSucceeded(status) {
  return typeof status === 'string' && GOAL_TURN_SUCCESS_STATUSES.includes(status);
}

function isGoalStatus(value) {
  return typeof value === 'string' && GOAL_STATUSES.includes(value);
}

/** Is this a goal record this host is willing to act on? Called with values. */
function isSessionGoal(value) {
  if (value === null) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (typeof value.objective !== 'string' || !value.objective.trim()) return false;
  if (Buffer.byteLength(value.objective, 'utf8') > GOAL_MAX_OBJECTIVE_BYTES) return false;
  if (!isGoalStatus(value.status)) return false;
  if (!Number.isSafeInteger(value.continuations) || value.continuations < 0) return false;
  return true;
}

/** Whether a goal in this state should start another turn on its own. */
function goalWantsContinuation(goal) {
  return Boolean(goal && GOAL_RUNNING_STATUSES.includes(goal.status));
}

/**
 * A person's next ordinary turn is an explicit re-entry into a paused goal.
 * Paused and blocked goals keep their objective, but the person has resumed
 * watching, so the autonomous-turn budget starts a fresh bounded run.
 */
function resumeGoalOnPersonTurn(goal) {
  if (!goal || !['paused', 'blocked'].includes(goal.status)) return goal;
  return makeGoal(goal.objective, { status: 'active', continuations: 0 });
}

/**
 * Normalise a person's objective into the stored shape, or throw the reason.
 * `fail` is injected so the host raises its own typed refusal and this file
 * stays free of the host's error machinery.
 */
function makeGoal(objective, { status = 'active', continuations = 0 } = {}) {
  const text = typeof objective === 'string' ? objective.trim() : '';
  if (!text) return null;
  return Object.freeze({
    objective: text,
    status: isGoalStatus(status) ? status : 'active',
    continuations: Number.isSafeInteger(continuations) && continuations >= 0 ? continuations : 0,
  });
}

/* Markdown emphasis, inline code fences and trailing sentence punctuation an
   agent may wrap a marker line in. Stripped before the comparison so a marker
   written as `**[[GOAL-ACHIEVED]]**` or "`[[GOAL-ACHIEVED]].`" still counts:
   the agent did the thing that was asked, in the formatting its provider
   habitually applies. */
function bareLine(line) {
  return String(line)
    .trim()
    .replace(/^[>\s]*[-*+]?\s*/, '')
    .replace(/^[`*_~\s]+/, '')
    .replace(/[`*_~\s.!]+$/, '')
    .trim();
}

/**
 * What the agent's own words say about the goal, read off the LAST non-empty
 * line only. Returns 'achieved', 'blocked', or null for "still working".
 *
 * Called with a whole turn's assistant text.
 */
function readGoalOutcome(text) {
  if (typeof text !== 'string' || !text) return null;
  const lines = text.split(/\r?\n/);
  let last = '';
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = bareLine(lines[index]);
    if (candidate) { last = candidate; break; }
  }
  if (!last) return null;
  const upper = last.toUpperCase();
  if (upper === GOAL_ACHIEVED_MARKER) return 'achieved';
  if (upper === GOAL_BLOCKED_MARKER) return 'blocked';
  return null;
}

/**
 * The instruction block that rides with every goal turn.
 *
 * Restated on EVERY continuation rather than once at the start, because a
 * long autonomous run compacts its own history: an instruction given only on
 * turn 1 is the first thing to fall out of context, and the marker protocol
 * failing silently looks exactly like an agent that will not stop.
 */
function goalInstructions(goal) {
  if (!goal || !GOAL_RUNNING_STATUSES.includes(goal.status)) return null;
  return [
    'STANDING GOAL FOR THIS CONVERSATION',
    '',
    goal.objective,
    '',
    'You are working toward this goal on your own. When this turn ends, this app'
    + ' starts your next turn automatically, so you do not need to ask permission to'
    + ' carry on and you should not stop to check in unless you are genuinely stuck.',
    '',
    `When the goal is fully achieved, end your reply with ${GOAL_ACHIEVED_MARKER}`
    + ' on a line of its own, as the last line, with nothing after it. That line is'
    + ' how this app knows to stop, and it is the only thing that ends the goal'
    + ' apart from the person clearing it or pressing Stop.',
    '',
    `If you cannot make further progress without the person, end your reply with ${GOAL_BLOCKED_MARKER}`
    + ' on a line of its own, as the last line, and say plainly above it what you'
    + ' need. Use this instead of repeating work you have already done.',
    '',
    'Do not write either marker until it is true.',
  ].join('\n');
}

/**
 * The text of a self-started turn.
 *
 * It reads as an instruction rather than as the person speaking, because it
 * is not the person speaking: the transcript shows who started each turn and
 * this sentence must not contradict it.
 */
function goalContinuationText(goal) {
  const turn = (goal?.continuations || 0) + 1;
  return `Continue working toward the standing goal. This is self-started turn ${turn};`
    + ' the person has not sent a new message. Pick up from where the previous'
    + ' turn ended rather than restarting, and do the next piece of real work'
    + ' rather than summarising what remains.';
}

/* ---------------------------------------------------------------- *
 * WHAT THE PERSON IS TOLD. Plain language, no codes, no mechanism.
 * The tests compare against these functions rather than their words,
 * so the wording can change here without touching a test.
 * ---------------------------------------------------------------- */

function goalSetSentence(goal) {
  return `Goal set: ${goal.objective} — this agent will keep working on its own until it reports the goal achieved, you clear the goal, or you press Stop.`;
}

function goalStartedSentence(goal) {
  return `Working toward the goal on its own (self-started turn ${goal.continuations}). You did not send this; press Stop to end it.`;
}

function goalAchievedSentence(goal) {
  return `The agent reports the goal achieved: ${goal.objective}. Nothing further will start on its own.`;
}

function goalBlockedSentence(goal) {
  return `The agent stopped short of the goal and says it needs you: ${goal.objective}. Read its last message. Nothing further will start on its own until you reply or set the goal again.`;
}

function goalStoppedSentence(goal) {
  return `Stopped. The goal is paused and nothing further will start on its own: ${goal.objective}. Send a message to carry on, or clear the goal.`;
}

function goalClearedSentence() {
  return 'The goal is cleared. This agent will only do what you ask it to from now on.';
}

/** `/goal` with no words: what is the goal right now? */
function goalCurrentSentence(goal) {
  if (!goal) return 'No goal is set on this agent. Type /goal followed by what you want done, and it will work toward it on its own.';
  if (goal.status === 'achieved') return `The agent reported this goal achieved: ${goal.objective}. Type /goal clear to clear it, or /goal with new words to set a new one.`;
  if (goal.status === 'blocked') return `This goal is waiting on you: ${goal.objective}. Read the agent's last message, then reply, or type /goal clear.`;
  if (goal.status === 'paused') return `This goal is paused: ${goal.objective}. Send a message to carry on, or type /goal clear.`;
  return `Working toward this goal on its own: ${goal.objective}. It has started ${goal.continuations} turn${goal.continuations === 1 ? '' : 's'} by itself. Press Stop to pause it, or type /goal clear.`;
}

function goalTurnFailedSentence(goal) {
  return `That turn did not finish successfully, so the goal is paused rather than started again: ${goal.objective}. Read the error above, then send a message to carry on, or clear the goal.`;
}

module.exports = {
  GOAL_TURN_SUCCESS_STATUSES,
  goalTurnSucceeded,
  goalTurnFailedSentence,
  GOAL_MAX_OBJECTIVE_BYTES,
  GOAL_ACHIEVED_MARKER,
  GOAL_BLOCKED_MARKER,
  GOAL_STATUSES,
  GOAL_RUNNING_STATUSES,
  isSessionGoal,
  isGoalStatus,
  makeGoal,
  goalWantsContinuation,
  resumeGoalOnPersonTurn,
  readGoalOutcome,
  goalInstructions,
  goalContinuationText,
  goalSetSentence,
  goalStartedSentence,
  goalAchievedSentence,
  goalBlockedSentence,
  goalStoppedSentence,
  goalClearedSentence,
  goalCurrentSentence,
};
