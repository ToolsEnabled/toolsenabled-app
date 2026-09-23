/* What the home screen is allowed to say, and in whose words.
 *
 * WHY THIS IS A SEPARATE MODULE AND NOT A BLOCK INSIDE home.js.
 *
 * The defect this exists to make impossible was measured on a real installed
 * build: the home screen told one person, in one viewport, both of these.
 *
 *     "No local agent fleet host detected on this machine."   (twice)
 *     "ToolsEnabled already works on this one computer."
 *
 * Nobody wrote that pair. It assembled itself, because five independent pieces
 * of the screen each answered a different question from a different source and
 * none of them could see what the others had already said. A rule that lives
 * inside a render function can only ever be checked by reading the render
 * function. So the decision of WHAT THE SCREEN SAYS is made here, as one pure
 * function over one input, returning one flat list of sentences -- and
 * tools/test/home-screen.test.mjs walks every reachable combination of that
 * input and asserts the list never contradicts itself and never repeats itself.
 * That check is only possible because the sentences are values, not DOM.
 *
 * ON VOCABULARY. The screen this replaced was written from inside the system:
 * "read-only projection", "audited bridge", "coordinator thread", "source
 * unavailable", "last health sweep". Every one of those names a mechanism. A
 * person opening this product owns agents, a computer, and some decisions
 * waiting on them; they do not own a projection. Nothing below names a
 * mechanism, an availability envelope, a transport, or a file. It is also
 * deliberately free of the punctuation a README uses and an interface does not:
 * no interpuncts between clauses, no ellipses on states, no em dash standing in
 * for a value that is simply absent. Where there is no reading, the screen
 * omits the line rather than printing a placeholder for it.
 */

import {
  DEFAULT_RUNS_MODE,
  planChatbox,
} from './chatbox-feed.js'
/* The remedy commands, imported rather than repeated. This screen and the agent
   page both tell a person how to install and sign in to Codex; two copies of a
   command line is two things to get wrong, and the one that goes stale is
   always the one nobody is looking at. That module is pure data and a lookup
   with no imports of its own, so this costs the home screen no module graph. */
import { ACCOUNT_SELECTION_REFUSALS, CODEX_SETUP_COMMANDS, codexSetupInstructions, unavailableReason } from './agent-availability-copy.js'
import { EDITOR_ATTACHMENT_REFUSALS } from './editor-attachment-copy.js'
/* THE DOOR OUT OF THE TWO DEAD ENDS ON THIS SCREEN, imported for the same
   reason the commands above are: the fleet graph, the comms board and Settings
   offer the same door, and four hand-written labels pointing at one page is four
   things to get wrong. The page behind it carries the explanation this screen is
   not allowed to print -- home's vocabulary rules ban the phrase "fleet host"
   and the fact row under the ring is capped at three, both correctly, and
   neither is a reason to leave a person holding a statement with nowhere to take
   it. */
import { GUIDE_ACTION, GUIDE_HREF } from './first-run-needs.js'
/* The one address of the connect screen, read rather than spelled: four
   surfaces link to it now and a link is only correct while all of them agree.
   src/device-claim-flow.js is a pure state machine with no DOM in it, so
   importing it here costs this module none of its testability. */
import { CONNECT_HREF } from './device-claim-flow.js'
/* THE MODEL ROW'S OWN NAME. `launchTier` is the table the start controls
   already use, so the runs list says "Sonnet" where the record kept the id it
   was started with, and no fourth copy of that mapping can drift from it. The
   module is pure data with no imports of its own. */
import { launchTier } from './orchestration-controls.js'
/* DID THAT TURN SUCCEED, asked once, in the module that measured the answer.
   The two engines do not use the same word for a turn that went well (codex
   says "completed", the Claude CLI says "success"), and a second allowlist here
   is exactly how this screen would come to report a good Claude turn as a
   failure. */
import { sessionTurnSucceeded } from './agent-session-events.js'
import { sampleSessionsRaw } from './sample-activity.js'
import { NODE_STATUS_WORDS, PALETTE_PANEL } from './fleet-tree-copy.js'
import { EXAMPLE_BADGE } from './comms-copy.js'

/* EVERY REMAINING SENTENCE THE SCREEN CAN PRINT.
 *
 * describeHome() below covers the copy that depends on what is true about the
 * machine. This covers the rest: the states a panel passes through while it
 * loads, the composer's label, and what the reply control says as a message
 * goes out. Those depend on the moment rather than on the state, so they cannot
 * be returned from a pure function of the machine's condition -- but they are
 * still sentences a person reads, and while they sat as literals inside the
 * view they were the one part of this screen no test was looking at.
 *
 * That gap was pointed out by the first-run lane, about its own code, in a form
 * that turned out to describe mine exactly: helpers only help if something
 * asserts the call sites use them, because a helper existing while one caller
 * still names a literal is precisely how the original defect comes back. There
 * were twelve such literals in src/views/home.js. tools/test/home-screen.test.mjs
 * now walks every value here for the same punctuation and vocabulary rules it
 * applies to describeHome(), and separately BANS user-facing string literals in
 * the view, so a thirteenth cannot be added quietly.
 *
 * Functions rather than strings where a name is interpolated: the test calls
 * them with a sample argument and checks the result, so the whole sentence is
 * covered and not just its fixed half. */
export const COPY = Object.freeze({
  conversationLoading: Object.freeze({
    title: 'Loading',
    body: 'Reading the conversation from the computer that holds it.',
  }),
  conversationUnreachable: Object.freeze({
    title: 'This conversation is on another computer',
    body: 'ToolsEnabled could not reach the computer that holds it.',
  }),
  conversationEmpty: Object.freeze({
    title: 'Nothing has been said yet',
    body: 'When your coordinator starts talking, it appears here.',
  }),
  runLabel: (sequence) => `Agent run ${sequence}`,
  runWhenUnknown: 'at a time this record does not give',
  /* WHAT THE RUN DID, per row, and the empty string is load-bearing.
     A run whose outcome was never recorded gets NO word rather than a
     reassuring one: the whole defect being repaired here is a screen that
     turned silence into success, and "started" printed on a run nobody
     recorded would be the same lie in a smaller font. The row still shows its
     number and time, so the person sees the run and simply is not told
     something the computer does not know. */
  runResult: (result) => (result === 'refused' ? NODE_STATUS_WORDS.failed : (result === 'started' ? 'started' : '')),
  /* WHY IT DID NOT START, from the code the record already held.
     The recorder writes a bare code on every refusal and readLocalSessions used
     to drop it, so a person whose every start was refused read "did not start"
     nine times over a record that knew the answer. The sentences are
     ENGINE_REASON's -- the same table this screen already uses for whether an
     agent could be started at all -- so the two halves of the screen cannot
     give one machine two different explanations, and the honesty guard that
     walks that table (tools/test/refusal-engine-honesty.test.mjs) covers this
     surface for free.
     THE EMPTY STRING IS THE POINT for a code nobody wrote a sentence for, and
     for a run recorded before reasons were kept. A row then says what it always
     said -- the number, the outcome, the time -- rather than being handed a
     guess. Falling back to unavailableReason() was considered and refused: its
     own fallback INVENTS "this copy could not work out why", which is a claim
     about a run, not an absence of one. */
  runReason: (code) => engineReason(code),
  /* WHAT IT WAS ASKED, labelled. The words after the label are the person's
     own brief, never this module's, and they are clipped rather than wrapped
     because the runs list is a column beside a conversation. */
  runAsked: (brief) => `Asked: ${brief}`,
  /* WHAT IT SAID BACK, labelled the way the brief is so the pair reads as a
     pair. The words after the label are the agent's own, never this module's,
     and they are clipped for the same reason the brief is.

     THE FIELD WAS THERE THE WHOLE TIME. `reply` is kept on the tree node
     precisely so a screen can show what an agent answered, and the two readers
     of that record both took `role` and `message` and dropped it. The owner's
     report on this list was that it shows no outputs, and this is the line that
     was missing rather than a new thing to record. */
  runSaid: (said) => `Said back: ${said}`,
  /* WHAT IT DID, COMPACTLY, and every figure in it was already on disk.
   *
   * The per-turn record (shell/usage-record.cjs) writes one signed line each
   * time a turn ends, carrying the turn, the model row, how the engine said
   * that turn ended, and the token figures. So a run can say how much work it
   * was without this screen timing anything or guessing anything.
   *
   * WHAT IT DELIBERATELY DOES NOT SAY. No duration, and no "it finished". The
   * run record holds the intent and the start and has no line for an ending, so
   * a length here could only be this window subtracting one clock from another
   * and calling it a measurement. Turns are counted, an ending nobody recorded
   * is not.
   *
   * Each part appears only if the record carries it, so a turn with no token
   * figure shortens the sentence instead of printing a zero. */
  runDid: ({ turns = 0, model = null, tokens = null, unfinished = 0 } = {}) => {
    if (!Number.isSafeInteger(turns) || turns < 1) return ''
    const counted = countOf(turns, 'turn', 'turns')
    const opening = model ? `${counted} on ${model}` : counted
    const spent = Number.isSafeInteger(tokens) && tokens > 0 ? `${opening} and ${groupDigits(tokens)} tokens` : opening
    if (Number.isSafeInteger(unfinished) && unfinished > 0) {
      return `${spent}, and ${countOf(unfinished, 'turn', 'turns')} did not finish.`
    }
    return `${spent}.`
  },
  /* THE ABSENCES, IN WORDS. The owner asked for a flow of what the agents did
     and said, and the honest answer for some runs is that nobody wrote it down.
     A blank row reads as a screen that is broken; these say which of the three
     absences it really is, and none of them invents an ask that was not
     recorded. */
  runNothingSaved: 'Nothing was saved for this run.',
  runNoAnswerYet: PALETTE_PANEL.whyNoReply,
  runNoAnswerSaved: 'No answer saved.',
  runNoTurns: 'No turns recorded.',
  /* Observed on the live stream by this window, right now, and it is the one
     state on the row that is not read back off a record. It says what is
     happening and never how long it has been happening. */
  runWorkingNow: 'Working now',
  /* THE LINES BETWEEN THE QUESTION AND THE ANSWER, labelled by who said them.
     The owner asked the home card to carry "the transcript turns, what was
     asked, what was said back", the way the chat does. The person's own lines
     are labelled "You"; an agent's are labelled with its role, or with this
     word when the record never named one; an action line (a tool that ran) is
     unlabelled, as it is in the transcript. */
  turnYou: 'You',
  turnAgent: (role) => role || 'The agent',
  /* The heading over the coordinator thread when it shares the card with the
     run list, so the two halves read as two things rather than as one list
     that changes register halfway down. */
  threadLabel: (target) => `Conversation with ${target}`,
  /* WHAT THE PANEL IS SHOWING WHEN A TREE IS PICKED (T401). Owner: "we have
     each tree as a single option, then we have ALL TREES but this shows just
     the tip of the tree when its active ... so then people can monitor just
     their top level agents more easily." The tips view says what it is rather
     than naming a lane, because it is not showing one. */
  treeScopeTitle: (name) => name || 'This tree',
  treeTipsTitle: 'Every tree, top level',
  /* THE DOOR FROM A RUN TO ITS REAL CHAT. The card shows a run; it does not take
     messages for one, because the only audited way to speak to a running agent
     is the tree rail on the computers page and the agent page. There is no
     per-node deep link (the router knows #/computers and #/agent/<computer>/
     <agent> and nothing finer), so the door opens the page and says so. */
  runDoor: Object.freeze({ label: 'Open it on the computers page', href: '#/computers' }),
  /* The aggregate of outcomes across the record. No longer printed on the home
     card -- the owner, with the footer paragraph on screen: "this little dialog
     box is kind of pointless" -- but src/local-metrics.js still reads it
     verbatim for the metrics page, so it stays. Returns null when the ledger
     says nothing either way, which is exactly the state every record written
     before outcomes existed is in -- an older ledger therefore reads as it
     always did rather than acquiring a made-up summary. */
  runOutcomes: (started, refused, total) => {
    const unknown = Math.max(0, total - started - refused)
    if (unknown === total) return null
    if (refused > 0 && started === 0 && unknown === 0) {
      return total === 1 ? 'It did not start.' : 'None of them started.'
    }
    if (refused > 0) return `${refused} of ${total} did not start.`
    if (unknown > 0) return `${started} of ${total} started; the rest were recorded before this copy kept outcomes.`
    return total === 1 ? 'It started.' : 'All of them started.'
  },
  /* The two settings the owner asked for, in the words the box uses when they
     leave it holding something back. Each one names the setting that caused it
     and offers the way to it, because a box that is empty for a reason the
     person cannot see is the failure this whole feature could most easily
     become.
     BOTH ADDRESS THE CATEGORY THAT HOLDS THOSE SETTINGS. The settings page
     draws one category at a time and `?category=` says which; a bare
     `#/settings` would open on the page it opens on for everybody, which is not
     the one these two sentences are about. The slug is derived from the section
     name (categorySlug in src/settings-presentation.js), and an address that
     stops matching one lands on the default category rather than an error --
     tools/test/settings-category-router.test.mjs keeps these two honest. */
  chatboxNothingChosen: Object.freeze({
    title: 'This box is set to show nothing',
    body: 'Agent runs are switched off for it and there is no conversation on this computer to put here instead.',
    action: Object.freeze({ label: 'Choose what appears in it', href: '#/settings?category=home-screen' }),
  }),
  chatboxNoAgentsChosen: Object.freeze({
    title: 'None of the agents talking are ones you picked',
    body: 'Somebody is saying something on this computer, and every one of them is switched off for this box.',
    action: Object.freeze({ label: 'Pick which agents appear', href: '#/settings?category=home-screen' }),
  }),
  chatboxAgentsHeld: (count) => `${count} ${String(count) === '1' ? 'agent is' : 'agents are'} being kept out of this box by your own choice.`,
  composerLive: (target) => `Message ${target}`,
  replyChecking: 'Checking whether replies can be sent',
  replyUnavailable: 'Replies cannot be sent right now',
  /* SENDING REPLIES SHIPS OFF, and until this sentence existed the box did not
     say so. It asked whether the message could be carried, was told yes, and
     enabled the input with "Replies will be sent and recorded" over it -- while
     the send itself returned early on a switch nobody had turned on. Typing and
     pressing Enter did nothing at all, silently, on a machine with the shipped
     defaults. That is the exact thing this screen refuses to do: an input that
     accepts nothing is worse than no input. */
  replyDisabled: 'Sending replies is switched off. Turn it on in Settings and this box will send and record them.',
  replyReady: 'Replies will be sent and recorded',
  replySending: 'Sending',
  replySent: 'Sent and recorded',
  replyRefused: 'That message was not sent. Nothing was recorded.',
  /* The example's conversation is a recording; its box says so rather than
     swallowing words, the same refusal shape every read-only chat uses. */
  exampleReadOnly: 'This is the example conversation. Open a computer to talk to a real coordinator.',
  /* Said where the decision gives the conversation no composer: a computer on
     its own, with no fleet coordinator to receive a message. */
  noComposerHere: 'There is no coordinator to message from this computer yet.',
})

/* Everything the screen can be in. Named states rather than booleans checked in
   sequence: a boolean ladder is exactly how the contradictory pair got in, and
   a state machine makes the illegal pair unreachable instead of unlikely. */
export const HOME_MODES = Object.freeze({
  /* Other computers are connected and answering. The fleet reading is the
     valuable one, so it gets the hero. */
  FLEET: 'fleet',
  /* Other computers are connected and NOT answering. Worth saying, once. */
  FLEET_UNREACHABLE: 'fleet-unreachable',
  /* This computer only, and agents have run here. Their record is the hero. */
  LOCAL: 'local',
  /* This computer only, and nothing has run here yet. Not an error. */
  LOCAL_IDLE: 'local-idle',
  /* The labelled demonstration, reachable from Settings. */
  SAMPLE: 'sample',
  /* Not the installed application: a plain browser pointed at the same build.
     There is no computer here to report on, which is a different thing from a
     computer with nothing on it, and must not be reported as a fault. */
  NO_HOST: 'no-host',
})

/* ---------------------------------------------------------------
   Reading the shell's reply.
   --------------------------------------------------------------- */

const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/**
 * Normalize `mcAgent.history()` into something a view can render without
 * re-validating it.
 *
 * THREE OUTCOMES, NOT TWO, and the third is the one worth naming. "No runs
 * yet", "the record could not be read", and "this copy cannot see a computer at
 * all" are three different sentences, and collapsing the third into the second
 * would have this page report a fault against a browser that is behaving
 * correctly. `undefined` means nobody could be asked; anything malformed means
 * somebody was asked and the answer did not parse.
 */
/* The lane name a start record carries, under either of the two names the two
   writers use for it. Text or null; never a guess. */
function agentOf(entry) {
  for (const value of [entry?.details?.agentId, entry?.agent]) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

/* THE FOURTH OUTCOME (owner direction 2026-09-20, T782 / BUG08): activity
   auditing switched OFF. The host answers history reads with
   { ok: false, code: 'AUDIT_NOT_ENABLED', reason } while the signed audit is
   off -- the Basic default -- and that is a state the person chose, not a
   record that would not open. It is kept apart from every other unreadable
   answer as `disabled: true` so no screen reports a fault against it. */
export const HISTORY_DISABLED_CODE = 'AUDIT_NOT_ENABLED'
export function historyDisabled(raw) {
  return isRecord(raw) && raw.ok === false && raw.code === HISTORY_DISABLED_CODE
}

export function readLocalSessions(raw) {
  const nothing = { total: 0, runs: Object.freeze([]), verified: null, started: null, refused: null }
  if (raw === undefined) {
    return Object.freeze({ supported: false, readable: false, disabled: false, ...nothing })
  }
  if (historyDisabled(raw)) {
    return Object.freeze({ supported: true, readable: false, disabled: true, ...nothing })
  }
  if (!isRecord(raw) || raw.ok !== true || !Array.isArray(raw.entries)) {
    return Object.freeze({ supported: true, readable: false, disabled: false, ...nothing })
  }
  const usable = raw.entries.filter(entry => isRecord(entry)
    && typeof entry.at === 'string'
    && Number.isFinite(Date.parse(entry.at))
    && Number.isSafeInteger(entry.sequence))

  /* An outcome is a SEPARATE record naming the start it resolves, so the two
     have to be rejoined here. Keyed on `resolves` rather than paired by
     adjacency because concurrent starts interleave in the ledger.

     WALKED OLDEST-FIRST, AND THAT ORDER IS THE FIX. `usable` arrives
     newest-first (history() reverses it -- "the order a reader wants"), but a
     duplicate outcome for one start must resolve the same way here as it does
     in the writer's own whole-chain count: shell/spawn-record.cjs's
     cachedTally() walks the file in LEDGER order and keeps the FIRST outcome it
     meets for a given `resolves`, "so a run can therefore never be tallied as
     both started and refused" -- that is the writer's own tie-break, and it is
     the count outcomeBreakdown() and statTiles() put on the strip. Keeping the
     newest-first order here instead, as an earlier version of this loop did,
     made the two disagree on the ONE ledger shape that can carry two outcomes
     for one start: the run row said whatever the LATEST duplicate claimed while
     the strip two tiles up kept counting from the EARLIEST one, so a single
     spurious extra line could make one screen say "started" over a row the
     numbers beside it still counted as a refusal -- "two copies of one rule"
     disagreeing about the same bytes. Reversing the walk here is the whole
     repair: the first outcome met in LEDGER order is kept, exactly as
     cachedTally() keeps it, so a duplicate can no longer overwrite the outcome
     that already resolved the start. */
  const resultBySequence = new Map()
  for (const entry of [...usable].reverse()) {
    const outcome = entry.outcome
    if (!isRecord(outcome)) continue
    if (outcome.result !== 'started' && outcome.result !== 'refused') continue
    if (!Number.isSafeInteger(outcome.resolves)) continue
    if (resultBySequence.has(outcome.resolves)) continue
    /* THE REASON RIDES WITH THE RESULT, and it used to be dropped here.
       The recorder writes it (shell/main.cjs recordSpawnOutcome, bounded to a
       bare upper-case code by the writer AND re-validated on the way out), and
       this function threw it away -- so a person whose every start was refused
       read "did not start" nine times and was never told why, on a screen
       holding the answer. `reason` is null on a start that worked and on every
       refusal recorded before the field existed; null is "this record does not
       say" and must never be rendered as a reason. */
    resultBySequence.set(outcome.resolves, {
      result: outcome.result,
      reason: typeof outcome.reason === 'string' && outcome.reason ? outcome.reason : null,
    })
  }

  /* A run is a START. Outcome records are ledger lines too, and counting them
     as runs would report twice as many agents as ever ran. An entry with NO
     action is still treated as a run: every reply from the recorder carries
     one, so the only things that reach this branch are older records and the
     hand-built fixtures the suite uses, and silently dropping those would make
     this function report zero runs on a ledger full of them. */
  const runs = usable
    .filter(entry => entry.action === undefined || entry.action === 'agent_session_start')
    .map(entry => {
      const outcome = resultBySequence.get(entry.sequence) || null
      return Object.freeze({
        sequence: entry.sequence,
        atMs: Date.parse(entry.at),
        /* null is "this record does not say", NEVER "it worked". Every screen
           below has to keep that distinction: an unrecorded outcome is exactly
           the state that used to be displayed as success. */
        result: outcome ? outcome.result : null,
        /* The bare code the shell recorded, or null. Turned into a sentence by
           runReason() below; never rendered raw. */
        reason: outcome ? outcome.reason : null,
        /* THE JOIN KEY, and the whole of the owner's second report. Without it
           a row can only ever say "Agent run 37"; with it a screen can find the
           conversation this app already saved for that session and say WHICH
           agent and WHAT it was asked. null when the record does not say, and
           an unmatched run simply renders as it always did. */
        sessionId: typeof entry.sessionId === 'string' && entry.sessionId ? entry.sessionId : null,
        /* WHICH LANE RAN, off the start record itself. The shell writes it as
           details.agentId (shell/main.cjs spawnRecordDetails) and the example
           writes it as `agent`; both were read past, so a row could only name
           its lane once a saved conversation existed for the session. A run
           and its conversation are written a beat apart, so for that beat the
           newest row on the screen had no lane on it at all -- which is the
           one row a person is looking at. null when the record does not say. */
        agentId: agentOf(entry),
      })
    })

  const tally = isRecord(raw.outcomes) ? raw.outcomes : null
  const counted = tally && Number.isSafeInteger(tally.starts) ? tally.starts : null
  const total = counted !== null && counted >= runs.length
    ? counted
    : (Number.isSafeInteger(raw.total) && raw.total >= runs.length ? raw.total : runs.length)

  return Object.freeze({
    supported: true,
    readable: true,
    disabled: false,
    total,
    runs: Object.freeze(runs),
    verified: raw.verified === true ? true : (raw.verified === false ? false : null),
    /* Whole-chain counts, or null when this copy's recorder does not report
       them. null must read as "unknown" everywhere downstream, not as zero --
       zero refusals is a claim, and this is an absence of one. */
    started: tally && Number.isSafeInteger(tally.started) ? tally.started : null,
    refused: tally && Number.isSafeInteger(tally.refused) ? tally.refused : null,
  })
}

/**
 * Can an agent be started on this computer at all? `mcAgent.availability()`
 * answers `{ok, code}`; the code is a fixed identifier, never a path, but it is
 * still a code, so it is translated here and never rendered raw.
 */
export function readAgentEngine(raw, sessionsEnabled = false) {
  const enabled = sessionsEnabled === true
  if (raw === undefined) return Object.freeze({ supported: false, ready: false, sessionsEnabled: enabled, why: null })
  if (isRecord(raw) && raw.ok === true) return Object.freeze({ supported: true, ready: true, sessionsEnabled: enabled, why: null,
    ...(['local', 'claude', 'gemini', 'grok', 'antigravity'].includes(raw.readyProvider) ? { readyProvider: raw.readyProvider } : {}),
  })
  const code = isRecord(raw) && typeof raw.code === 'string' ? raw.code : ''
  return Object.freeze({
    supported: true,
    ready: false,
    sessionsEnabled: enabled,
    why: engineReason(code) || 'This copy is not set up to run agents yet',
  })
}

/* One sentence per reason a start would be refused, because the fallback below
   ("not set up to run agents yet") is true of a copy with no engine and simply
   WRONG about a copy whose engine is fine and whose payload is missing the
   permission-level enforcement -- a distinction the shell now reports and this
   screen would otherwise throw away. The agent page carries the same map with
   more detail; this one stays at the register of a home screen. */
export const ENGINE_REASON = Object.freeze({
  RULES_POLICY_UNAVAILABLE: 'ToolsEnabled could not load the rules needed for this agent. Reinstall or update ToolsEnabled from a complete build, then try again',
  ...ACCOUNT_SELECTION_REFUSALS,
  AGENT_IMAGE_UNSUPPORTED: 'This provider cannot receive images. Choose a provider with image support or remove the images before sending',
  AGENT_MODE_UNAVAILABLE: 'This session no longer offers that provider mode. Refresh provider modes and choose an available mode',
  AGENT_MODE_SELECTION_UNCONFIRMED: 'The provider mode change could not be confirmed. Refresh provider modes to check the current setting before another change',
  AGENT_STOP_PENDING: 'The agent has not finished stopping. Retry Halt before sending more work, or close the session',
  AGENT_SWITCH_STALE: 'The conversation changed during a model switch. Check the active session before choosing another model',
  AGENT_SWITCH_ACCOUNT_UNAVAILABLE: 'The model switch could not use the selected account. Check its sign-in in Accounts and choose an available account',
  AGENT_SWITCH_NOT_STANDALONE: 'Change this session’s model using its tree controls in Computers',
  AGENT_SWITCH_ACCOUNT_INVALID: 'The model and account choices do not match. Choose an account for the selected provider or automatic selection',
  AGENT_SWITCH_HISTORY_UNAVAILABLE: 'The model switch could not link the existing conversation. Keep it open and check conversation history before retrying',
  AGENT_SWITCH_CLEANUP_REQUIRED: 'The model switch still needs recovery. Keep its conversation open and check its status before another switch',
  AGENT_CLOUD_COMMAND_INVALID: 'The cloud request could not be read. Enter /cloud followed by the work you want done, and check any worker limit you included',
  ...EDITOR_ATTACHMENT_REFUSALS,
  AGENT_TREE_PARENT_UNAVAILABLE: 'This delegated agent’s parent is no longer available. Select a running parent in its tree before starting it again.',
  TREE_DELEGATION_REFUSED: 'The inherited boundary for this delegated agent is unavailable. Start it again from its parent tree after the boundary is restored.',
  AGENT_TOOL_MODE_ROLE_CONFLICT: 'This role requires ToolsEnabled functions. Enable a ToolsEnabled tool mode in Settings before starting a new agent.',
  TOOL_API_DISABLED: 'This session has native provider tools only. Choose a ToolsEnabled tool mode and start a new session to use ToolsEnabled functions.',
  AGENT_ENGINE_UNAVAILABLE: 'This copy is not set up to run agents yet',
  AGENT_CONFINEMENT_UNAVAILABLE: 'This copy did not ship the permission-level enforcement an agent session needs, so it will not start one',
  AGENT_CONFINEMENT_ACCOUNT_PROFILE_UNAVAILABLE: 'ToolsEnabled could not establish which Windows account owns this installation, so it refused to load an agent. Close ToolsEnabled and open the copy installed for this Windows account',
  AGENT_CONFINEMENT_WRONG_PRINCIPAL: 'ToolsEnabled is running under a Windows account that does not own this installation, so it refused to load an agent. Close ToolsEnabled and open it from the Windows account that owns it',
  AGENT_CONFINEMENT_FOREIGN_PROFILE: 'This agent start points into a different Windows account, so ToolsEnabled refused it before opening anything there. Open the copy installed for this Windows account and choose a folder owned by this account',
  AGENT_CONFINEMENT_FOREIGN_PROFILE_ENVIRONMENT: 'This agent start points into a different Windows account, so ToolsEnabled refused it before opening anything there. Open the copy installed for this Windows account and choose a folder owned by this account',
  AGENT_CONFINEMENT_PROFILE_PATH_UNREADABLE: 'ToolsEnabled could not safely check an agent path inside this Windows account, so it refused the start. Close ToolsEnabled, check that the account folder is available, and try again',
  AGENT_CONFINEMENT_PROFILE_PATH_INVALID: 'ToolsEnabled could not safely check an agent path inside this Windows account, so it refused the start. Close ToolsEnabled, check that the account folder is available, and try again',
  AGENT_CONFINEMENT_PROFILE_PATH_UNAVAILABLE: 'ToolsEnabled could not safely check an agent path inside this Windows account, so it refused the start. Close ToolsEnabled, check that the account folder is available, and try again',
  AGENT_CONFINEMENT_PROFILE_REPARSE_REFUSED: 'An agent path crosses a linked folder inside this Windows account, so ToolsEnabled refused it rather than follow the link. Choose an ordinary folder owned directly by this account',
  AGENT_CONFINEMENT_PROFILE_REPARSE_POINT: 'An agent path crosses a linked folder inside this Windows account, so ToolsEnabled refused it rather than follow the link. Choose an ordinary folder owned directly by this account',
  AGENT_CONFINEMENT_PROFILE_ENVIRONMENT_INVALID: 'ToolsEnabled could not construct a safe launch environment for this Windows account, so nothing was started. Close ToolsEnabled and open the copy installed for the account that owns it',
  AGENT_ACCOUNT_RECOVERY_UNAVAILABLE: 'The original agent could not be verified for account recovery, so no replacement was started. Review the agent and its role in Computers before starting it again',
  AGENT_ACCOUNT_RECOVERY_NO_ALTERNATE: 'Account recovery has no other eligible sign-in to use, so no replacement was started. Add or sign in to another account in Settings, or wait for the current account to have allowance again',
  AGENT_ACCOUNT_RECOVERY_IDENTITY_MISMATCH: 'The earlier agent moved to a different place in the tree, so account recovery did not start a replacement. Review the agent and its role in Computers before starting it again',
  AGENT_ACCOUNT_RECOVERY_STOPPED: 'The earlier agent was stopped, so account recovery did not start a replacement. Review the agent in Computers and start it again when you want it to run',
  AGENT_PREDECESSOR_CLEANUP_FAILED: 'The earlier agent has not finished closing, so account recovery did not start a replacement. Use Stop on that agent in Computers, then start it again',
  ACCOUNT_CLIENT_UNAVAILABLE: 'The chosen account is not registered for this assistant client, so the agent will not start. Choose an account registered for that client in Accounts',
  PROVIDER_LOGIN_NOT_INSTALLED: 'The program this model needs is not installed here, so the agent will not start. Install it in Settings, under This computer, then start the agent again',
  AGENT_RESUME_SOURCE_UNAVAILABLE: 'The saved conversation could not be checked for this agent, so it was not resumed. Close any session still using it, then choose Resume again',
  CODEX_RESUME_SOURCE_INVALID: 'The saved conversation could not be joined to a new session, so it was not resumed. Update ToolsEnabled, then choose Resume again',
  CODEX_RESUME_IDENTITY_MISMATCH: 'The saved file belongs to a different conversation, so this agent was not resumed. Start a new agent for this work instead',
  CLAUDE_RESUME_IDENTITY_MISMATCH: 'The saved file belongs to a different conversation, so this agent was not resumed. Start a new agent for this work instead',
  AGENT_CONFINEMENT_PROVIDER_INVALID: 'The selected assistant program could not be given a protected session, so it will not start. Choose a supported model; if it still refuses, update ToolsEnabled and try again',
  AGENT_CONFINEMENT_ACCOUNT_COLLISION: 'ToolsEnabled could not safely resolve the selected assistant account to one signed-in folder, so nothing was started. Remove and add that assistant account again in Settings, then start a new agent',
  AGENT_CONFINEMENT_ACCOUNT_INVALID: 'ToolsEnabled could not safely resolve the selected assistant account to one signed-in folder, so nothing was started. Remove and add that assistant account again in Settings, then start a new agent',
  AGENT_PROVIDER_ISOLATION_UNAVAILABLE: 'This DEV session needs matching app and engine support for private provider accounts. Create a new DEV session from the updated source',
  AGENT_PROVIDER_ISOLATION_ACCOUNT_REQUIRED: 'Add a named provider account in this DEV session and sign in to it before starting an agent',
  AGENT_PROVIDER_ISOLATION_INVALID: 'This DEV session’s private profile could not be established. Create a new DEV session before starting an agent',
  AGENT_PROVIDER_ISOLATION_PATH: 'A provider account or program leaves this DEV session’s private profile. Add the account and install the program inside this session',
  AGENT_PROVIDER_ISOLATION_ENVIRONMENT: 'The provider could not keep its settings and cache inside this DEV session. Create a new DEV session before starting an agent',
  AGENT_PROVIDER_ISOLATION_CREDENTIAL_STORE: 'This provider’s sign-in store is shared outside the DEV session. Sign in to a new private account using its Sign in button',
  AGENT_PROVIDER_ISOLATION_EXECUTABLE_REQUIRED: 'Install this provider inside the DEV session using its Install button, then start the agent again',
  AGENT_CONFINEMENT_AGENT_ID_INVALID: 'ToolsEnabled could not safely build the protected assistant home and tool configuration, so nothing was started. Close ToolsEnabled and open it again; if it keeps refusing, reset its local agent data or reinstall from a complete build',
  AGENT_CONFINEMENT_ACCOUNT_MARKER_UNREADABLE: 'ToolsEnabled could not safely resolve the selected assistant account to one signed-in folder, so nothing was started. Remove and add that assistant account again in Settings, then start a new agent',
  AGENT_CONFINEMENT_ACCOUNT_UNRESOLVED: 'ToolsEnabled could not safely resolve the selected assistant account to one signed-in folder, so nothing was started. Remove and add that assistant account again in Settings, then start a new agent',
  AGENT_CONFINEMENT_CREDENTIAL_BUSY: 'ToolsEnabled could not safely attach the selected assistant sign-in to the protected session, so nothing was started. Close other agent sessions, sign in to that assistant again if needed, then start a new agent',
  AGENT_CONFINEMENT_CREDENTIAL_UNLINKABLE: 'ToolsEnabled could not safely attach the selected assistant sign-in to the protected session, so nothing was started. Close other agent sessions, sign in to that assistant again if needed, then start a new agent',
  AGENT_CONFINEMENT_SIGN_IN_UNAVAILABLE: 'ToolsEnabled could not safely attach the selected assistant sign-in to the protected session, so nothing was started. Close other agent sessions, sign in to that assistant again if needed, then start a new agent',
  AGENT_CONFINEMENT_ACCOUNT_FENCE_UNAVAILABLE: 'ToolsEnabled could not safely build the protected assistant home and tool configuration, so nothing was started. Close ToolsEnabled and open it again; if it keeps refusing, reset its local agent data or reinstall from a complete build',
  AGENT_CONFINEMENT_HOME_SCRUB_INCOMPLETE: 'ToolsEnabled could not safely build the protected assistant home and tool configuration, so nothing was started. Close ToolsEnabled and open it again; if it keeps refusing, reset its local agent data or reinstall from a complete build',
  AGENT_CONFINEMENT_RUNTIME_NOT_NODE: 'ToolsEnabled could not safely build the protected assistant home and tool configuration, so nothing was started. Close ToolsEnabled and open it again; if it keeps refusing, reset its local agent data or reinstall from a complete build',
  AGENT_CONFINEMENT_SERVER_COMMAND_INVALID: 'ToolsEnabled could not safely build the protected assistant home and tool configuration, so nothing was started. Close ToolsEnabled and open it again; if it keeps refusing, reset its local agent data or reinstall from a complete build',
  AGENT_CONFINEMENT_SERVER_ENTRY_INVALID: 'ToolsEnabled could not safely build the protected assistant home and tool configuration, so nothing was started. Close ToolsEnabled and open it again; if it keeps refusing, reset its local agent data or reinstall from a complete build',
  AGENT_CONFINEMENT_SESSION_CREDENTIAL_INVALID: 'ToolsEnabled could not safely build the protected assistant home and tool configuration, so nothing was started. Close ToolsEnabled and open it again; if it keeps refusing, reset its local agent data or reinstall from a complete build',
  AGENT_CONFINEMENT_HOME_UNAVAILABLE: 'the protected home your permission level runs an assistant in could not be prepared, so no session was started',
  AGENT_CONFINEMENT_HOME_UNWRITABLE: 'a folder name on the computer you are driving contains a character ToolsEnabled will not write into an assistant configuration. It will not start a session it cannot hold to your permission level. Choose a different folder in Settings',
  AGENT_CONFINEMENT_NOT_ISOLATED: 'this session was prepared for a permission level that does not match the one recorded here, so it was not started',
  AGENT_CONFINEMENT_BROWSER_TOOLS_INVALID: 'ToolsEnabled could not correctly signal whether this assistant needs browser tools, so nothing was started. Close ToolsEnabled and open it again; if it keeps refusing, reset its local agent data or reinstall from a complete build',
  AGENT_CONFINEMENT_RECORD_ABSENT: 'the computer you are driving has not been set up yet, so a session would run at the most restrictive level. Open Settings and choose a permission level',
  AGENT_CONFINEMENT_RECORD_UNREADABLE: 'the permission level recorded on the computer you are driving cannot be read. ToolsEnabled will not start a session at a level it cannot confirm. Choose the level again in Settings',
  AGENT_CONFINEMENT_TIER_REFUSED: 'the permission level recorded on the computer you are driving is not one this copy recognises. No session can be started under it. Choose the level again in Settings',
  AGENT_CONFINEMENT_TIER_UNMAPPED: 'the permission level recorded on the computer you are driving has no session rules in this copy, so it will not start one. Re-choose the level in Settings',
  /* The one reason on this list that is not a fault at all, and the only one
     the reader can clear themselves -- so it says what to do rather than what
     is wrong. */
  /* THE FIRST THING A STRANGER SEES, and for one release it was a dead end: the
     screen named what was missing and the product contained no button, link or
     instruction anywhere that said how to get it. Both of these now carry the
     command, because the command IS the remedy and a home screen that knows the
     remedy and withholds it is choosing to be tidy over being useful. The
     commands themselves live in agent-availability-copy.js so the three screens
     that give them cannot drift apart. */
  /* The sign-in goes in a NEW window: the one the install ran in cannot see
     the new program and calls it not recognized -- the first external user's
     exact dead end; src/first-run-needs.js carries the full account. */
  AGENT_CODEX_CLI_NOT_INSTALLED: `Codex is not installed on this computer, and it is the program that runs an agent. Run "${CODEX_SETUP_COMMANDS.install}" in Windows Terminal, then "${CODEX_SETUP_COMMANDS.signIn}" in a new terminal window`,
  AGENT_CONFINEMENT_SIGNED_OUT: `Codex is installed but nobody is signed in to it. Run "${CODEX_SETUP_COMMANDS.signIn}" in Windows Terminal, then come back to this screen`,
  CODEX_CLI_NOT_FOUND: `Codex could not be found when a session tried to start it. Run "${CODEX_SETUP_COMMANDS.install}" in Windows Terminal, then "${CODEX_SETUP_COMMANDS.signIn}"`,
  CODEX_VERSION_DETECTION_FAILED: 'Codex is installed here but did not answer when asked its version, so ToolsEnabled will not build a session on it',
  CODEX_VERSION_DETECTION_TIMEOUT: 'Codex took too long to report its version, so the session did not start',
  CODEX_START_TIMEOUT: 'Codex took too long to open the session; try starting it again when the computer is less busy',
  CODEX_START_CLEANUP_UNPROVEN: 'Codex did not finish starting, and ToolsEnabled could not confirm that it stopped',
  CODEX_VERSION_CLEANUP_UNPROVEN: 'The Codex version check did not finish, and ToolsEnabled could not confirm that it stopped',
  CODEX_CLI_INCOMPATIBLE: `The Codex here cannot run a session. It lacks something a session needs, or it gave an answer this copy cannot read. Run "${CODEX_SETUP_COMMANDS.update}" in Windows Terminal, then start again. If Codex is already up to date, update ToolsEnabled`,
  CODEX_PROTOCOL_VERSION_MISMATCH: `the Codex here did not identify itself as a usable CLI. Run "${CODEX_SETUP_COMMANDS.installWithNode}" in Windows Terminal to repair the Codex installation`,
  AGENT_SESSION_FAILED: 'A session did not start and this copy could not work out why',
  AGENT_LAUNCH_ENVIRONMENT_UNAVAILABLE: 'This copy did not ship the protection that keeps an agent session off your billed API account, so it will not start one',
  AGENT_HOST_INVALID_CWD: 'ToolsEnabled cannot use its own workspace folder, so an agent has nowhere to run',
  AGENT_HOST_INVALID_ARGUMENT: 'ToolsEnabled could not check whether an agent can run here',
  AGENT_HOST_CLOSED: 'ToolsEnabled is shutting down',
  AGENT_ROLE_BINDING_INVALID: 'The saved role directions are incomplete, so ToolsEnabled will not start this agent. Reopen the Role library, save that role again, then retry',
  AGENT_ROLE_TOOL_RESTRICTION_UNAVAILABLE: 'The app and engine cannot apply the same role limits. No agent was started. Install a matching app and engine update, then retry',
  AGENT_ROLE_TOOL_RESTRICTION_INVALID: 'The saved role has invalid function settings. No agent was started. Open the Role library, save that role again, then retry',
  AGENT_ROLE_TOOL_SERVER_UNSUPPORTED: 'This engine cannot provide the functions selected for the role. No agent was started. Install a matching app and engine update, then retry',
  AGENT_OPTIMIZED_TOOLS_UNSUPPORTED: 'Optimized works with Claude only, so this assistant was not started. Your saved tool setting is unchanged. Start it with a Claude account, or choose Only, Enabled or Disabled for Agent API in quick settings, then retry',
  AGENT_CONFINEMENT_STATE_PATH_TOO_LONG: 'The app data folder path is too long to start this assistant. Use a shorter supported app data location in the owning account, then retry',
  AGENT_SESSION_IDENTITY_TRANSPORT_UNAVAILABLE: 'ToolsEnabled could not establish its app-owned agent identity channel, so it did not start the named agent. Close ToolsEnabled, open it again, then retry',
  AGENT_SESSION_ROOT_GUARD_UNAVAILABLE: 'The app and engine do not support the same final launch guard. No agent program was started. Install a matching app and engine update, then retry',
  MC_TREE_BOUNDED_WORK_REFUSED: 'The selected parent, saved tree, profile, or time cap changed before work could start. Check the selected running agent and retry',
  MC_TREE_BOUNDED_WORK_CAP_REACHED: 'The time cap ended while this work was starting. Choose a longer cap and retry',
  TREE_DELEGATION_REFUSED: 'The parent’s current tree authority no longer matches this start. Retry from the current running parent',
  OWNER_HOST_NOT_READY: 'The app-owned session authority is no longer available. No agent program was started. Reopen ToolsEnabled, then retry',
  /* MEASURED on a candidate build 2026-09-18 (T377 item 3): two refused runs
     carried this code and the Metrics page bucketed both under "The record
     does not say why" -- a claim about the RECORD that the record contradicts,
     which is the same failure this file's header records for
     AGENT_TOOLS_ALL_DISABLED. Its four OWNER_HOST_* siblings were already in
     both tables; only this one was in neither. The remedy names the folder
     question because that is the boundary owner-host.js could not verify. */
  OWNER_HOST_PERMISSION_UNAVAILABLE: 'The working folder allowed for this session could not be confirmed. No agent program was started. Check the folder under Settings → Setup → Working folders, then retry',
  /* MEASURED on a candidate build 2026-09-18 (T377 items 2 and 3): one Resume
     press ended with this code and the Metrics page filed it under "The record
     does not say why". The record said why. The Claude program had exited
     before the session was ready -- its own stderr read "No conversation found
     with session ID", because the saved thread lived in a sign-in other than
     the one the start selected -- and this code was in neither table. The
     sentence names both halves a person can act on: the program closed, and a
     Resume whose conversation is not in the selected sign-in cannot continue. */
  CLAUDE_CLI_CLOSED: 'The Claude program closed before the session was ready. No agent was started. If this was a Resume, the saved conversation may not exist in the selected sign-in; choose that sign-in or Start over, then retry',
  /* See the note on this code in src/agent-availability-copy.js: it sent a
     person to reload a screen twice over, and reload is not the remedy. */
  OWNER_HOST_SESSION_BINDING_INVALID: 'This agent was not started. Try once more. If it happens again, update ToolsEnabled or choose another model',
  OWNER_HOST_SESSION_REFUSED: 'The session identity or its saved role is no longer current. No agent program was started. Reload this screen and check its role before retrying',
  OWNER_HOST_SESSION_UNKNOWN: 'The current organisation or role could not be read. No agent program was started. Wait for that storage to be available, then retry',
  /* THE SAME FALSE CLAIM, A THIRD TIME, AND THIS TIME FOUND BY HAND RATHER THAN
     BY READING. MEASURED 2026-09-19 on a private candidate: a refused run
     carrying OWNER_HOST_MODULE_INVALID was bucketed by the Metrics Start-issues
     panel under "The record does not say why" while the signed record held the
     code. A census of every OWNER_HOST_* code startAppOwnedOwnerHost() in
     shell/capability-layer.cjs can record then found FIVE of ten in neither
     table, not one -- the four below and the one above them.

     They are one family to the person in front of the screen: this copy's
     installed agent parts are absent, damaged, or refused to start. So the
     remedy is the same and it is an honest one -- retrying will not clear any of
     them, and none of these says "retry". What differs between them is what was
     found, and the sentences keep that difference because a support reader needs
     it. */
  OWNER_HOST_PAYLOAD_ABSENT: 'The part of ToolsEnabled that starts agents is not present in this copy. No agent program was started. Install ToolsEnabled again from the same place you got it, then retry',
  OWNER_HOST_ENTRYPOINT_ABSENT: 'The part of ToolsEnabled that starts agents is installed but its main file is missing. No agent program was started. Install ToolsEnabled again from the same place you got it, then retry',
  OWNER_HOST_MODULE_INVALID: 'The part of ToolsEnabled that starts agents is installed but could not be loaded. No agent program was started. Install ToolsEnabled again from the same place you got it, then retry',
  OWNER_HOST_START_FAILED: 'The part of ToolsEnabled that starts agents would not start itself. No agent program was started. Reopen ToolsEnabled; if it happens again, install it again from the same place you got it',
  /* NOT A START AT ALL, and the copy must not read like one: this is recorded
     when a session could not be confirmed CLOSED. Saying "no agent program was
     started" here would be false. */
  OWNER_HOST_CLOSE_UNCONFIRMED: 'ToolsEnabled could not confirm that this session was fully closed. Reopen ToolsEnabled, and check Computers for anything still running before starting more',
  AGENT_RESOURCE_GRANT_USED: 'This reservation already permitted a launch. No additional agent program was started. Start again to request a fresh reservation',
  AGENT_RESOURCE_POLICY_CHANGED: 'Resource settings changed during preparation. No agent program was started under the old settings. Retry with the current policy',
  /* THE SAME FALSE CLAIM LIVED HERE TOO, AND ITS SECOND CORRECTION WAS ALSO
     OVERTAKEN. It has now named Claude as unstartable through three rewrites,
     and the reason it was wrong changed underneath each one. The last version
     read "A Claude or local agent type was chosen, and this copy will not start
     one from the tree." The Claude engine ships in the payload now
     (capability/src/lib/agent-engine/claude-cli-process.js, present in the
     installed 1.0.20), and resolveStartTier() opens the Claude tiers on a
     require() of it -- so the provider this code is actually raised for is
     decided by what a given build carries, and this table cannot know it.
     A home screen has no tier in hand and therefore names no provider at all.
     tools/test/refusal-engine-honesty.test.mjs is what stops a fourth version
     of this sentence from naming an engine the payload is carrying. */
  AGENT_TIER_NO_LAUNCHER: 'An agent type was chosen that this copy carries no launcher for, so it will not start one. The model menu on the tree marks which types this copy can start',
  /* The program is here and this installation will not seat it. A separate code
     from the line above so neither sentence has to hedge about which ran. */
  AGENT_TIER_SESSION_ACTOR_UNSUPPORTED: 'This installation cannot start the agent type that was chosen. Update ToolsEnabled or choose another model',
  /* Everything is present and nobody has signed in yet, which is not a fault --
     so this sentence says what to do rather than what is broken. A third code
     for the same reason the second exists: neither of the two above should have
     to hedge about which of the three is true.
     NOT the out-of-allowance case. An account with nothing left this hour is
     still signed in and still offered; the product moves to another account by
     itself. Telling that person to sign in would be advice nothing satisfies. */
  AGENT_TIER_NO_SIGNED_IN_ACCOUNT: 'No account is signed in for the agent type that was chosen, so it will not start one. Sign in to one in Accounts, or choose a type you are already signed in to',
  AGENT_MEMORY_LOW: 'This computer is nearly out of memory, so ToolsEnabled did not start another assistant. Closing one you have finished with makes room',
  AGENT_RESOURCE_UNKNOWN: 'Resource measurements are missing or stale; additional starts are waiting',
  AGENT_RESOURCE_PRESSURE: 'CPU or app responsiveness is under pressure; additional starts are waiting',
  AGENT_RESOURCE_WARMING: 'A stable resource window is being measured before another start',
  AGENT_RESOURCE_STARTS_BUSY: 'Other agents are still starting',
  AGENT_RESOURCE_PACING: 'The current launch is settling before another start',
  AGENT_RESOURCE_PROVIDER_UNKNOWN: 'This program has no configured resource estimate',
  AGENT_RESOURCE_CONTROLLER_UNKNOWN: 'Current resource advice from the declared controller is needed',
  AGENT_RESOURCE_CONTROLLER_HOLD: 'The controller has paused additional starts',
  SPAWN_RECORD_NO_KEYSTORE: 'This copy cannot reach the operating system’s secure key storage that protects the record of what runs here, so it will not start an agent',
  SPAWN_RECORD_NO_DIRECTORY: 'ToolsEnabled has nowhere to keep its record of what runs here, so it will not start an agent',
  SPAWN_RECORD_KEYSTORE_UNAVAILABLE: 'The operating system’s secure key storage is unavailable to ToolsEnabled. It cannot protect its activity record, so it will not start an agent',
  SPAWN_RECORD_KEY_UNREADABLE: 'The record of what has run here cannot be opened, so ToolsEnabled will not add to it',
  SPAWN_RECORD_LEDGER_CORRUPT: 'The record of what has run here does not read back as a record, so ToolsEnabled will not add to it',
  SPAWN_RECORD_UNAVAILABLE: 'The record of what runs here cannot be opened, so ToolsEnabled will not start an agent',
  MC_AGENT_INVALID_PAYLOAD: 'This copy is not set up to run agents yet',
})

/* THE ONE HOME-SCREEN FACT THAT IS NOT KEYED BY A REFUSAL CODE, so it cannot
   live in ENGINE_REASON above: it is reached when the engine says an agent CAN
   start (`engine.ready`) and providerSignInReading() separately proves Codex
   specifically is signed out. It carries the same "Run ... in Windows
   Terminal" instruction as the table beside it and was written inline inside
   describeHome() until this pass, which is exactly the shape this module's own
   header warns against: "copy that lives inside a render function can only be
   checked by reading the render function". It is a value now so
   tools/test/reader-remedy-coverage.test.mjs can hold it to the same rule the
   table is held to. */
export const CODEX_SIGNED_OUT_FACT = `This copy can start an agent, but nobody is signed in to Codex yet. Run "${CODEX_SETUP_COMMANDS.signIn}" in Windows Terminal, then come back to this screen`

/* THE SAME TABLE, READ FOR THE PLATFORM THE READER IS ON.
 *
 * ENGINE_REASON's Codex-setup entries name Windows Terminal and winget, and a
 * Linux reader was shown both. Measured on this machine before the fix:
 * ENGINE_REASON.AGENT_CODEX_CLI_NOT_INSTALLED told a Linux owner to run
 * "winget install OpenAI.Codex" in Windows Terminal, and neither of those
 * exists there.
 *
 * THE LINUX SENTENCE IS NOT WRITTEN AGAIN HERE. unavailableReason() in
 * src/agent-availability-copy.js already composes a platform-correct sentence
 * for exactly these codes, and tools/test/setup-review-readiness.test.mjs
 * already holds it to never naming winget or Windows Terminal on linux. This
 * delegates for those codes rather than growing a second copy of the same
 * prose for the two to drift apart.
 *
 * ONLY FOR CODES THIS TABLE ALREADY KNOWS, which keeps the objection recorded
 * at runReason intact: unavailableReason()'s own fallback invents "this copy
 * could not work out why", which is a claim about a run rather than an absence
 * of one, and an unknown code never reaches it from here. */
const CODEX_SETUP_CODES = new Set([
  'AGENT_CODEX_CLI_NOT_INSTALLED',
  'AGENT_CONFINEMENT_SIGNED_OUT',
  'CODEX_CLI_NOT_FOUND',
  'CODEX_PROTOCOL_VERSION_MISMATCH',
  'CODEX_CLI_INCOMPATIBLE',
])

export function engineReason(code, { platform = globalThis.mcSetup?.platform } = {}) {
  if (typeof code !== 'string' || !Object.prototype.hasOwnProperty.call(ENGINE_REASON, code)) return ''
  if ((platform === 'linux' || platform === 'darwin') && CODEX_SETUP_CODES.has(code)) {
    return unavailableReason(code, { platform })
  }
  return ENGINE_REASON[code]
}

/* The signed-out fact, with the terminal the reader actually has. Same shape
   as the Windows sentence; only the terminal noun moves, and it is taken from
   codexSetupInstructions() so one place decides what a terminal is called. */
export function codexSignedOutFact({ platform = globalThis.mcSetup?.platform } = {}) {
  if (platform === 'linux' || platform === 'darwin') {
    const { terminal } = codexSetupInstructions({ platform })
    return `This copy can start an agent, but nobody is signed in to Codex yet. Run "${CODEX_SETUP_COMMANDS.signIn}" in ${terminal}, then come back to this screen`
  }
  return CODEX_SIGNED_OUT_FACT
}


/* ---------------------------------------------------------------
   Time, in words.
   --------------------------------------------------------------- */

/**
 * Plain English, and never a symbol standing in for a number. Returns null for
 * an unreadable input so callers omit the phrase instead of printing a dash.
 */
/* ONE RUN, WITH EVERYTHING THIS COMPUTER ACTUALLY WROTE DOWN ABOUT IT.
 *
 * THE REPORT THIS EXISTS FOR. The owner, on the installed build: the activity
 * list shows "Agent run 37 - started" and a relative time, and nothing else. He
 * named the repository whose agent feeds get this right, and what they carry is
 * always the same three things -- which agent, what it was asked, what happened
 * -- never a bare identifier and a verb.
 *
 * WHERE EACH PART HONESTLY COMES FROM, because this is the line where a screen
 * starts inventing.
 *
 *   what happened   the signed record: the outcome, and the bare refusal CODE
 *                   the shell wrote beside it. Turned into a sentence by
 *                   COPY.runReason, which is silent for a code nobody wrote one
 *                   for.
 *   which agent     the person's own saved conversation for that session --
 *                   the ROLE they picked. The ledger does not carry it and must
 *                   not: it is the app's own record of what STARTED, not a copy
 *                   of what was said.
 *   what it asked   the same place: the brief they typed. Deliberately not in
 *                   the ledger either (see shell/agent-launch-audit's rule: a
 *                   launch record is evidence a session started, not a copy of
 *                   its prompt), so this is a JOIN and never a new field on
 *                   disk.
 *
 * AN UNMATCHED RUN LOSES NOTHING. A run started from another surface, from
 * another computer's record, or before session ids crossed, simply has no
 * conversation to find, and its row renders exactly as it always did. That is
 * the whole reason this is a join rather than a requirement.
 *
 * `conversations` is a Map (or any object with .get) from session id to
 * { role, asked, reply, said, ... } and, where the reader kept the transcript,
 * `turns`: the saved lines as { who: 'you'|'agent'|'action', text, at }. The
 * view builds it from what the person has saved; this function neither reads
 * storage nor knows where it came from.
 */
export const RUN_BRIEF_CHARS = 96

export const RUN_SAID_CHARS = 200

/* HOW MUCH WORK ONE RUN WAS, out of the per-turn record and nothing else.
 *
 * `turns` is the rows src/local-metrics.js readLocalUsage() already parsed,
 * narrowed to one session by the caller. Pure, so the whole table of shapes can
 * be walked without a browser.
 *
 * THE TWO RULES THAT KEEP THE FIGURE HONEST.
 *
 *   A `session-total` row is the engine's RUNNING total for the session, so the
 *   largest one is the session's spend and adding them would multiply it by the
 *   number of times the engine happened to report. Turn rows are added. A
 *   session with both is counted from its turn rows, exactly as the metrics
 *   page does it, because those are the finer reading.
 *
 *   A turn only counts as unfinished when the engine actually said how it
 *   ended and the word was not one of the success words. A turn with NO status
 *   is a turn nobody wrote an ending for, and calling that a failure is the
 *   same invention this whole screen is being repaired for.
 *
 * THE TWO FIGURES ARE COUNTED OVER THE SAME ROWS, and that is not a tidiness
 * rule -- it is the only thing keeping the sentence possible. The unfinished
 * tally used to walk every row while the turn count walked the turn rows alone,
 * and the two sets are not the same set: shell/usage-record.cjs attaches the
 * turn's `status` to every line it writes, `basis` included, so a codex session
 * whose engine also reported a running total carried that ending word twice
 * over. One turn that ended in error, reported once as a turn and twice as a
 * running total, printed "1 turn and 1,200 tokens, and 2 turns did not finish."
 * -- two of one. A person reading their own run cannot repair that; the only
 * reading left is that the screen is broken.
 *
 * So `unfinished` is counted over exactly the rows `turns` counted, which makes
 * `unfinished <= turns` true by construction rather than by luck. A session
 * that offered nothing but running totals is unchanged: there the two sets ARE
 * the same set, and this reads as it always did.
 */
export function summariseRunWork(turns) {
  const rows = Array.isArray(turns) ? turns.filter(row => row && typeof row === 'object') : []
  if (rows.length === 0) return null
  const counted = rows.filter(row => row.basis !== 'session-total')
  const model = launchTier(rows.find(row => typeof row.tier === 'string' && row.tier)?.tier || '')?.label || null
  /* The rows this run is counted from: its turn rows when it has any, and the
     running totals only when they are all there is. Every figure below reads
     this one list so no two of them can disagree about what a turn was. */
  const basis = counted.length > 0 ? counted : rows

  let tokens = null
  if (counted.length > 0) {
    for (const row of counted) {
      if (Number.isSafeInteger(row.totalTokens)) tokens = (tokens ?? 0) + row.totalTokens
    }
  } else {
    for (const row of rows) {
      if (Number.isSafeInteger(row.totalTokens) && (tokens === null || row.totalTokens > tokens)) tokens = row.totalTokens
    }
  }

  const unfinished = basis.filter(row => typeof row.status === 'string' && row.status
    && !sessionTurnSucceeded(row.status)).length

  return Object.freeze({
    turns: basis.length,
    model,
    tokens,
    unfinished,
  })
}

export function describeRun(run, conversations = null, nowMs = Date.now(), { work = null, live = null } = {}) {
  const said = run && run.sessionId && conversations && typeof conversations.get === 'function'
    ? conversations.get(run.sessionId)
    : null
  const clip = (value, limit = RUN_BRIEF_CHARS) => {
    const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
    if (text.length === 0) return ''
    return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`
  }

  /* WHAT IT SAID BACK, from the three places it can honestly come from, newest
     first. The live stream is this window watching the turn happen; `reply` is
     the answer the tree kept on the node; `said` is the last agent line in the
     saved conversation, which outlives a node whose reply was cleared. Nothing
     is assembled and nothing is summarised. These are the agent's own words or
     there are none. */
  const working = Boolean(live && live.working)
  const streaming = clip(live && typeof live.text === 'string' ? live.text : '', RUN_SAID_CHARS)
  const kept = clip(said && typeof said.reply === 'string' ? said.reply : '', RUN_SAID_CHARS)
  const spoken = clip(said && typeof said.said === 'string' ? said.said : '', RUN_SAID_CHARS)
  const answer = streaming || kept || spoken

  /* WHICH ABSENCE THIS ROW IS IN, and there are four of them. They are ordered
     so the row names the outermost missing thing: a run with no saved
     conversation at all cannot also be missing an answer, and a run that was
     refused is not waiting for one. Exactly one sentence, or none. */
  let gap = ''
  /* AN ANSWER OUTRANKS EVERY ABSENCE, and this order is the repair for a
     contradiction measured on the packaged build. A run started from the tree
     is written to the signed record the instant it starts, and its NODE reaches
     saved storage a beat later, so for that beat the list holds a run with a
     live answer streaming into it and no saved conversation to join to. The
     absences were asked first, so the row printed the agent's actual words above
     a sentence saying no answer had been saved for it. Both were true of
     different sources and together they were nonsense, which is precisely the
     failure this screen was rewritten to make unreachable. */
  if (answer) gap = ''
  else if (!said) gap = COPY.runNothingSaved
  else if (working || said.status === 'starting' || said.status === 'running') gap = COPY.runNoAnswerYet
  else if (run.result !== 'refused') gap = COPY.runNoAnswerSaved

  /* AND THE SECOND ABSENCE, WHICH IS ABOUT THE WORK RATHER THAN THE WORDS. Only
     said of a run that really started: a run that was refused has no turns by
     definition, and printing that under a refusal reason would be the screen
     explaining itself twice.

     GATED ON THE SENTENCE AND NOT ON THE READING, deliberately. runDid() is
     silent for a reading it cannot describe, and testing `work` here instead
     would let a row that produced no sentence render a blank line -- which is
     the exact thing this row is being repaired for. Whatever makes the sentence
     empty, the row says the turns were not recorded. */
  const did = work ? COPY.runDid(work) : ''
  /* AND NOT WHILE THE TURN IS STILL HAPPENING. Read off the packaged build with
     a real agent: a row said "Working now" in green and, one line below, "No
     turns were recorded for it." Both were true -- the turn record is written
     when a turn ENDS, and that one had not -- and together they read as the
     screen arguing with itself about an agent the person can watch typing. A
     turn in progress is not a turn nobody recorded. */
  const noWork = !did && !working && run.result === 'started' ? COPY.runNoTurns : ''

  /* THE LINES BETWEEN, for the open row. The saved transcript carries the whole
     conversation; the row already prints its first line as "Asked:" and its
     last agent line as "Said back:", so those two are trimmed off here rather
     than printed twice -- a leading 'you' line only when it IS the brief, and
     a trailing 'agent' line always, because that is the answer by definition.
     Anything else in the record is shown in the order it happened, and a
     record with no transcript gives an empty list rather than an invented one. */
  const asked = clip(said && typeof said.asked === 'string' ? said.asked : '')
  const savedTurns = said && Array.isArray(said.turns)
    ? said.turns.filter(line => line && typeof line === 'object' && typeof line.text === 'string' && line.text.trim())
    : []
  let first = 0
  let last = savedTurns.length
  if (first < last && savedTurns[first].who === 'you' && clip(savedTurns[first].text) === asked) first += 1
  if (first < last && savedTurns[last - 1].who === 'agent') last -= 1
  const turns = Object.freeze(savedTurns.slice(first, last).map(line => Object.freeze({
    who: line.who === 'you' || line.who === 'action' ? line.who : 'agent',
    text: line.text,
  })))

  return Object.freeze({
    sequence: run.sequence,
    result: run.result,
    /* Separately-absent facts, and each absence is rendered by leaving the line
       out rather than by printing a stand-in. */
    resultWord: COPY.runResult(run.result),
    why: run.result === 'refused' ? COPY.runReason(run.reason) : '',
    agent: clip(said && typeof said.role === 'string' ? said.role : ''),
    asked,
    said: answer,
    turns,
    /* True only while this window is watching the stream carry that session.
       It is an observation, not a reading of a record, and it is the only
       liveness claim this row makes. */
    working,
    did,
    noWork,
    gap,
    when: whenWords(nowMs - run.atMs) || COPY.runWhenUnknown,
    /* The exact instant, for the row's own tooltip. A list that only ever says
       "3 days ago" cannot be lined up against anything else that happened. */
    at: Number.isFinite(run.atMs) ? new Date(run.atMs).toLocaleString() : '',
  })
}

export function whenWords(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null
  const seconds = Math.floor(ms / 1000)
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return minutes <= 1 ? 'a minute ago' : `${minutes} minutes ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return hours === 1 ? 'an hour ago' : `${hours} hours ago`
  const days = Math.round(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  const months = Math.round(days / 30)
  if (months < 12) return months === 1 ? 'last month' : `${months} months ago`
  const years = Math.round(months / 12)
  return years === 1 ? 'last year' : `${years} years ago`
}

const countOf = (n, one, many) => `${n} ${n === 1 ? one : many}`

/* Thousands separated, and written here rather than taken from
   Number.toLocaleString(): that function answers differently depending on the
   machine's language settings, so the same record would read one way on this
   computer and another way on the next, and no test could pin either. */
function groupDigits(value) {
  const digits = String(Math.trunc(value))
  let out = ''
  for (let index = 0; index < digits.length; index += 1) {
    if (index > 0 && (digits.length - index) % 3 === 0) out += ','
    out += digits[index]
  }
  return out
}

/* ---------------------------------------------------------------
   The decision.
   --------------------------------------------------------------- */

/**
 * @param {object} input
 * @param {boolean} input.sample          the labelled demonstration is showing
 * @param {boolean} input.fleetConfigured other computers have been connected
 * @param {object|null} input.fleetHealth  {available, total, ok, down, unknown, atMs}
 * @param {object|null} input.peer         {reachable, name, atMs}
 * @param {object} input.sessions          from readLocalSessions
 * @param {object} input.engine            from readAgentEngine
 * @param {object|null} input.providers    from providerSignInReading, or null
 *                                         when this caller has not asked
 * @param {object|null} input.account      {known, connected}, or null when this
 *                                         caller has not asked
 * @param {object|null} input.approvals    {readable, count, undelivered}
 * @param {object} input.chatbox           {runsMode, selection, agentsInSource}
 * @param {number} input.nowMs
 *
 * @returns a description, never a rendering. `clock` is null whenever there is
 * no real instant to count from -- the screen then shows no digits at all,
 * because four dashes under the word SECONDS is a broken clock and a person
 * reads it as one.
 */
export function describeHome(input) {
  const {
    sample = false,
    fleetConfigured = false,
    fleetHealth = null,
    peer = null,
    sessions: sessionsInput = readLocalSessions(null),
    engine = readAgentEngine(null),
    /* NULL MEANS THIS CALLER HAS NOT ASKED, and that must render exactly what it
       rendered before this input existed. A default that assumed either answer
       would put a verdict on screen that nobody measured. */
    providers = null,
    /* WHETHER THIS COMPUTER IS ON THE PERSON'S TOOLSENABLED ACCOUNT, as
       {known, connected}. NULL means nobody has asked -- a plain browser has no
       installed application to ask, and a window whose read was refused has
       asked and learned nothing. Both must render the same thing, and it is not
       a verdict either way. */
    account = null,
    approvals = null,
    chatbox = null,
    nowMs = Date.now(),
  } = input || {}

  /* THE DEMONSTRATION READS ITS OWN RECORD, NEVER THIS COMPUTER'S.
     Substitution rather than suppression -- the reasoning is in
     src/sample-activity.js. This is deliberately the ONLY place the swap can
     happen: it sits above everything that reads `sessions`, so there is exactly
     one line where a real record could ever reach an example-badged screen, and
     it is this one. */
  const sessions = sample ? readLocalSessions(sampleSessionsRaw(nowMs)) : sessionsInput

  const mode = pickMode({ sample, fleetConfigured, fleetHealth, sessions })
  const newestRun = sessions.runs.length ? Math.max(...sessions.runs.map(run => run.atMs)) : null

  /* ---- the hero ---- */
  let clock = null
  let caption = 'This computer'
  let headline = null

  if (mode === HOME_MODES.FLEET) {
    clock = fleetHealth.atMs
    caption = 'Last checked'
    headline = fleetHeadline(fleetHealth)
  } else if (mode === HOME_MODES.FLEET_UNREACHABLE) {
    caption = 'Your computers'
    headline = 'The computers you connected could not be reached'
  } else if (mode === HOME_MODES.LOCAL) {
    clock = newestRun
    caption = 'Last agent run'
    headline = `${countOf(sessions.total, 'agent run', 'agent runs')} on this computer`
  } else if (mode === HOME_MODES.SAMPLE) {
    /* The product's own shape, FILLED from the example's record rather than
       emptied of everything. This branch used to set no clock and a headline
       that only announced itself as an example, which left the demonstration
       looking like the live screen with its contents deleted -- worse than the
       thing it exists to show.

       The word "example" stays in the HEADLINE and not only in the badge.
       tools/test/home-screen.test.mjs asserts the hero says so itself, and it
       is right to: a person reads the big sentence, not the small label. */
    clock = newestRun
    caption = 'Last agent run'
    headline = `${countOf(sessions.total, 'agent run', 'agent runs')} in this example fleet`
  } else if (mode === HOME_MODES.NO_HOST) {
    caption = 'ToolsEnabled'
    headline = 'Open ToolsEnabled on your computer to see what has run there'
  } else if (sessions.disabled) {
    /* Auditing off is the person's own setting. Scoped to NEW runs (root
       narrowing 2026-09-21): already-admitted audited work may still finish
       recording, so the hero does not claim nothing at all is being written. */
    caption = 'This computer'
    headline = engine.ready ? 'Ready when you are; new runs are not being recorded' : 'Not ready yet; new runs are not being recorded'
  } else if (!sessions.readable) {
    caption = 'This computer'
    headline = 'The record of what has run here could not be read'
  } else {
    /* Deliberately NOT a second "nothing has run here". The panel two inches to
       the right already says that, and it is the panel's job to; a hero
       repeating it in almost the same words was the first thing wrong with this
       screen when it was looked at rather than reasoned about. The hero answers
       a different question -- what state is this computer in -- and on a fresh
       install the honest answer is a good one. */
    caption = 'This computer'
    headline = engine.ready ? 'Ready when you are' : 'Not ready yet'
  }

  /* ---- the short true statements under the hero ----
     Assembled in one place so the whole set is visible at once. This is the
     list the contradiction test walks. */
  const facts = []

  if (mode === HOME_MODES.SAMPLE) {
    facts.push({ id: 'sample', tone: 'neutral', text: 'Turn this off in Settings to see your own computer' })
  } else if (mode === HOME_MODES.NO_HOST) {
    facts.push({ id: 'engine', tone: 'neutral', text: 'This page is running in a browser, not the installed app' })
  } else {
    /* Whether agents can run here. Stated once, positively when it is true --
       a person needs to know this either way, and it is the single most
       load-bearing fact about the product on a machine with nothing connected.
     *
     * IT HAD TWO STATES AND THE MACHINE HAS THREE, which is the whole of this
     * repair. `engine.ready` is mcAgent.availability(), and that answers "can
     * this INSTALLATION start anything" -- shell/agent-host.cjs opens it when a
     * Claude start is genuinely possible, proved as the payload carrying the
     * engine plus the `claude` program resolving, and NEVER on any sign-in,
     * because Claude's sign-in file is presence-only and can never be a proof.
     * That decision is right: it stops the product calling itself broken on a
     * machine correctly set up for Claude.
     *
     * Home then rendered that installation-shaped answer as a fact about the
     * COMPUTER. Driven on the packaged build, cold install, three arms:
     *
     *   codex signed out, claude installed        availability ok -> "Agents can run on this computer"
     *   codex signed out, claude SIGNED IN        availability ok -> identical, and correct: one can
     *   codex signed out, claude NOT INSTALLED    availability refuses -> "Not ready yet", correct
     *
     * The middle arm is why this is not simply inverted: a green there is TRUE.
     * The first arm is the defect -- nothing signed in to either provider, and a
     * green tick, while the setup review one screen earlier says an agent cannot
     * yet run and the press then refuses for exactly that reason.
     *
     * This codebase already states the rule it broke: 'unknown' IS A REAL ANSWER
     * AND IS NEVER ROUNDED UP (src/setup-review-readiness.js).
     * engineAvailability() honours it in the REFUSAL direction; home took the
     * resulting non-refusal and rounded it up into a claim. Same rule, opposite
     * direction, and the positive direction is the one a person acts on.
     *
     * So the green now rests on a proven sign-in, and the middle ground says
     * what is true and what was not checked instead of picking an end. */
    if (!engine.ready) {
      facts.push({ id: 'engine', tone: 'warn', text: engine.why })
    } else if (engine.readyProvider === 'local') {
      facts.push({ id: 'engine', tone: 'good', text: 'Local agents can run on this computer without a provider sign-in' })
    } else if (!providers || providers.known !== true || providers.anySignedIn === true) {
      /* A caller that never asked keeps exactly the sentence it had; a reply
         that taught nothing is not evidence against the machine. */
      facts.push({ id: 'engine', tone: 'good', text: 'Agents can run on this computer' })
    } else if (engine.readyProvider) {
      facts.push({ id: 'engine', tone: 'neutral', text: 'An assistant program is available on this computer. Check its sign-in in Settings before starting an agent' })
    } else if (providers.codexSignedOut === true) {
      facts.push({
        id: 'engine',
        tone: 'warn',
        text: codexSignedOutFact(),
      })
    } else {
      /* Ready, nothing proven signed in, and nothing proven signed out either.
         Saying "agents can run" would round an unknown up and saying they cannot
         would round it down; both have cost somebody a wrong screen already. */
      facts.push({
        id: 'engine',
        tone: 'neutral',
        text: 'This copy can start an agent. It could not check whether anybody is signed in to the program that runs one',
      })
    }

    /* The other computers. Exactly one sentence, and only one of these three
       branches can ever be taken, which is the whole point of the mode. */
    if (mode === HOME_MODES.FLEET && peer?.reachable) {
      const when = whenWords(nowMs - peer.atMs)
      facts.push({
        id: 'peer',
        tone: 'good',
        text: when ? `Connected to ${peer.name}, checked ${when}` : `Connected to ${peer.name}`,
      })
    } else if (mode === HOME_MODES.FLEET) {
      /* Health read, link unread. NOTHING is said, deliberately: a fleet whose
         services just reported in is plainly answering, so "your computers are
         not answering" would be flatly contradicted by the headline directly
         above it. The link's own freshness is a detail for the computers page,
         not a headline claim on home. */
    } else if (mode === HOME_MODES.FLEET_UNREACHABLE) {
      facts.push({ id: 'peer', tone: 'warn', href: GUIDE_HREF, text: 'Nothing has been heard from them recently' })
    } else {
      /* THE OWNER'S OWN REPORT, AND THE ONE ROW ON THE FIRST SCREEN THAT COULD
       * ANSWER IT: "as a user I dont even see how after signing up that I now
       * connect my computer".
       *
       * WHAT THIS ROW USED TO SAY AND WHY IT WAS WORSE THAN NOTHING. "This is
       * the only computer connected", linked to the guide. Every word of it was
       * true and all of it was about the LAN fleet -- and it was the only
       * sentence on the first screen using the word "connected", on a screen a
       * person reaches minutes after paying for an account and being asked, on
       * the website, to connect a computer. It sent them to a guide whose
       * account content is about Codex and Claude folders, which says in as many
       * words that "there is no setting that connects one". So the one place on
       * home that mentions a second computer led to the one page that told them
       * to stop looking.
       *
       * WHAT IT SAYS NOW IS THE ACCOUNT FACT, AND IT LEADS TO THE SCREEN THAT
       * CHANGES IT. The fleet meaning of "connected" leaves the first screen
       * entirely rather than sitting beside a fourth line on the densest screen
       * in the product; `#/computers` is where a fleet is described, and it has
       * its own door to the same place now.
       *
       * THREE SENTENCES BECAUSE THERE ARE THREE ANSWERS AND ONE OF THEM IS "WE
       * HAVE NOT ASKED". `account` is null until this window has read the
       * installed application's claim status, and a null is not a no -- the
       * product has been burned by rounding exactly that up, in this file, in
       * the engine row forty lines above. The unread case is written as an
       * invitation, which asserts nothing and still leads somewhere. */
      const joined = account && account.known === true ? account.connected === true : null
      facts.push({
        id: 'account',
        tone: 'neutral',
        href: CONNECT_HREF,
        text: joined === true
          ? 'This computer is on your ToolsEnabled account'
          : joined === false
            ? 'This computer is not on your ToolsEnabled account yet'
            : 'Connect this computer to your ToolsEnabled account',
      })
    }

    /* Decisions waiting. Omitted entirely when the count could not be read: a
       home screen is not the place that reports why a queue is unreadable, and
       "0 waiting" when eight are queued would be the one wrong thing it could
       say. Zero is stated positively, because "nothing needs you" is
       information a person wants. */
    if (approvals?.readable) {
      /* Decisions he ALREADY MADE that did not land -- src/approval-outcomes.js.
         Absence reads as zero, which is the only reading of a missing field that
         cannot invent a failure, and it is clamped to the pending count so this
         row can never claim more failures than there are requests left to fail.
         That clamp is also what makes "nothing was approved" corroborated rather
         than asserted: a decision that HAD landed would have taken its request
         out of the queue, so a failure that is still counted here is a failure
         the engine is still confirming by keeping the request pending. */
      const undelivered = Number.isSafeInteger(approvals.undelivered) && approvals.undelivered > 0
        ? Math.min(approvals.undelivered, approvals.count)
        : 0

      /* ONE row, not two. The cap under the ring is three facts and it is a real
         cap (tools/test/home-screen.test.mjs), because five notices in a
         viewport is what made this screen unreadable. So when a decision he made
         did not land, that DISPLACES the waiting count rather than joining it:
         both are true, the failed request is itself one of the waiting ones, and
         only one of them corrects something he currently believes. The count is
         one click away on the screen this row links to. */
      facts.push(
        undelivered > 0
          ? {
            id: 'approvals',
            tone: 'warn',
            href: '#/ledger?tab=p',
            text: `${countOf(undelivered, 'decision', 'decisions')} you made ${undelivered === 1 ? 'was' : 'were'} not recorded, so nothing was approved`,
          }
          : approvals.count > 0
            ? { id: 'approvals', tone: 'warn', href: '#/ledger?tab=p', text: `${countOf(approvals.count, 'decision', 'decisions')} waiting for you` }
            : { id: 'approvals', tone: 'good', text: 'Nothing is waiting for your approval' },
      )
    }
  }

  const panel = Object.freeze(describePanel(mode, sessions, engine, chatbox))

  return Object.freeze({
    mode,
    clock,
    caption,
    headline,
    facts: Object.freeze(facts.map(Object.freeze)),
    panel,
    /* An input a person can type into but that accepts nothing is worse than no
       input at all, so the composer exists only where it does something. A
       conversation the person has switched OFF for this box is one of the
       places it does nothing: the reply would be accepted, recorded, and never
       appear. FLEET only, and no longer the demonstration: the thread reply is
       the one audited sink (postBridgeAction, isWriteEnabled('thread-reply')),
       the example composer faked its replies, and a LOCAL run has no receiver
       here -- its real chat is the tree rail and the agent page, reached
       through the door on the row. */
    composer: mode === HOME_MODES.FLEET && panel.context,
    /* Every sentence this screen will print, flattened. The test walks this. */
    statements: Object.freeze([headline, ...facts.map(fact => fact.text), ...panelStatements(panel)].filter(Boolean)),
  })
}

function pickMode({ sample, fleetConfigured, fleetHealth, sessions }) {
  if (sample) return HOME_MODES.SAMPLE
  /* Checked before the fleet, because a browser cannot report on a fleet
     either -- the projections it can read are the ones bundled in the build. */
  if (!sessions.supported) return HOME_MODES.NO_HOST
  if (fleetConfigured) {
    return fleetHealth?.available && Number.isFinite(fleetHealth.atMs)
      ? HOME_MODES.FLEET
      : HOME_MODES.FLEET_UNREACHABLE
  }
  return sessions.readable && sessions.runs.length > 0 ? HOME_MODES.LOCAL : HOME_MODES.LOCAL_IDLE
}

function fleetHeadline(health) {
  const { total, ok, down, unknown } = health
  if (down > 0) return `${down} of ${total} ${down === 1 ? 'service is' : 'services are'} down`
  if (unknown > 0) return `${ok} of ${total} services are running and ${unknown} could not be checked`
  return total === 1 ? 'The one service you run is up' : `All ${total} services are running`
}

/* ---------------------------------------------------------------
   The panel between the braces.
   --------------------------------------------------------------- */

/* TWO HALVES, NOT ONE OF THREE KINDS.
 *
 * This function used to answer "which single thing is in the box" from the
 * state of the machine alone: a demonstration, a conversation, or a list of
 * runs, never two at once. The owner asked for the two to be independently
 * controlled -- which agents' context appears, and whether runs appear too, not
 * at all, or on their own -- so the box now has a context half and a runs half
 * and this decides each one separately.
 *
 * WHAT THE MACHINE STILL DECIDES, and what it no longer decides. The machine
 * decides what is AVAILABLE: only the demonstration and a reachable coordinator
 * have a conversation to show. Runs are available in every mode -- a computer
 * shows its own record, and the demonstration shows the example fleet's. Mixing
 * this computer's real run record into a box badged as an example would still
 * make half of it true, which is why the demonstration is given a record of its
 * own in describeHome rather than being shown this machine's or being emptied. The
 * settings decide, out of what is available, what a person actually sees.
 */
function describePanel(mode, sessions, engine, chatbox) {
  /* A CONVERSATION IS ONLY THE COORDINATOR THREAD NOW. The demonstration used
     to bring its own written transcript into this half; the owner asked for
     one card with the live list as the foundation and the transcript's
     substance folded into each run's row, so the example shows the same rows a
     real machine does (with their own asks, lines and answers) and has no
     separate conversation half. */
  const contextAvailable = mode === HOME_MODES.FLEET
  /* Every mode now has runs to show, including the demonstration -- ITS OWN,
     never this computer's; see the substitution in describeHome. This read
     `mode !== SAMPLE`, which was the honesty rule ("mixing this computer's real
     run record into a box badged as an example would make half of it true")
     implemented as showing nothing at all. The rule is intact; what changed is
     that the example now has a record of its own to be honest about. */
  const runsAvailable = true
  const plan = planChatbox({
    contextAvailable,
    runsAvailable,
    runsMode: chatbox?.runsMode ?? DEFAULT_RUNS_MODE,
    selection: chatbox?.selection ?? null,
    agentsInSource: chatbox?.agentsInSource ?? [],
  })

  const panel = {
    /* Which conversation the renderer should load, or none. NOT "what is in the
       box": `runs` is its own flag now, because both can be true. */
    kind: plan.showContext ? 'conversation' : 'none',
    context: plan.showContext,
    runs: plan.showRuns,
    title: panelTitle(mode, plan),
    /* A demonstration is badged whatever it is showing, and real data never is.
       The badge follows the MODE and not the contents, so no combination of
       these two settings can produce an example that is not labelled. */
    badge: mode === HOME_MODES.SAMPLE ? EXAMPLE_BADGE : null,
    empty: null,
    contextEmpty: null,
    footer: null,
    /* The GATED count, because this number becomes a sentence a person reads.
       It was the raw one, and in "show only runs" that printed "3 agents are
       being kept out of this box by your own choice" beside a list of runs and
       no conversation at all -- a complaint about a filter over a half that is
       not on screen. The raw count is still on the plan for anyone who wants to
       ask what widening the selection would bring back. */
    hiddenAgents: plan.contextHiddenAgents,
  }

  /* Nothing at all was chosen. Said plainly, with the way back to the choice,
     rather than quietly putting one of the halves back. */
  if (!plan.showContext && !plan.showRuns) {
    panel.empty = { ...COPY.chatboxNothingChosen, action: { ...COPY.chatboxNothingChosen.action } }
    return panel
  }

  if (plan.contextFilteredToNothing) {
    panel.contextEmpty = { ...COPY.chatboxNoAgentsChosen, action: { ...COPY.chatboxNoAgentsChosen.action } }
  }

  if (plan.showRuns) {
    if (mode === HOME_MODES.NO_HOST) {
      panel.empty = {
        title: 'Nothing to show in a browser',
        body: 'ToolsEnabled shows the agents that have run on a computer. Open the installed app to see them.',
      }
    } else if (sessions.disabled) {
      panel.empty = {
        title: 'Activity auditing is off',
        body: 'ToolsEnabled is not keeping a record of the agents it starts here while activity auditing is off. Saved history is preserved. Turn on Signed activity audit under Advanced settings to record new runs.',
      }
    } else if (!sessions.readable) {
      /* FLEET_UNREACHABLE, LOCAL and LOCAL_IDLE all show the same thing: what
         has run on THIS computer. A fleet that is not answering does not stop
         the machine in front of the person from having a history. */
      panel.empty = {
        title: 'The record could not be read',
        body: 'ToolsEnabled keeps a record of every agent it starts here, and this copy could not open it. Nothing has been lost; new runs are still recorded.',
      }
    } else if (sessions.runs.length === 0) {
      panel.empty = {
        title: 'No agents have run here yet',
        body: engine.ready
          ? 'When you start an agent, every run shows up here. ToolsEnabled writes each one down on this computer before it starts.'
          : 'When this copy can run agents, every run will show up here.',
        /* The one next step, and only when it is genuinely the next step.
           Running an agent from this window is a control a person switches on
           themselves, so an installation that has not switched it on is told
           where the switch is. An installation that has is told nothing here,
           because a button that repeats what the person already did is
           clutter, and a button pointing at a screen that cannot help them is
           worse than clutter.

           THE THIRD BRANCH IS THE ONE THAT WAS MISSING, and it is the branch a
           stranger lands on. An engine that is NOT ready got `null` here: the
           box said "When this copy can run agents, every run will show up here"
           and offered nothing, on the exact screen where the person has just
           been told their computer cannot run one. The fact row above already
           names the cause and gives the command; this control leads to the page
           that says what the whole product needs, which is the question a person
           in that state is actually asking. */
        action: engine.ready
          /* THE ADDRESS NAMES THE SWITCH, because the page it opens has 219
             controls on it. `engine.sessionsEnabled` is isWriteEnabled('agent-session'),
             so the row this sentence is about is `write_agent-session` -- "Run
             an agent session", in the Write section. Measured on the packaged
             build before this carried the id: following this link put a person
             at the top of Settings with that row 10170px below them AND inside
             a collapsed tier carrying `inert`, so scrolling could not reach it
             either. src/views/settings.js reads the id, opens the section to the
             depth the row lives at, and scrolls to it. */
          ? (engine.sessionsEnabled ? null : { label: 'Turn on agent sessions in Settings', href: '#/settings?setting=write_agent-session' })
          : { ...GUIDE_ACTION },
      }
    } else {
      panel.footer = recordFooter(sessions)
    }
  }

  /* An empty runs half is not an empty BOX when a conversation is beside it,
     and the renderer needs to know which of the two it is. */
  if (panel.empty && plan.showContext && !plan.contextFilteredToNothing) {
    panel.runsEmptyBesideContext = true
  }

  if (plan.contextHiddenAgents > 0) {
    const held = COPY.chatboxAgentsHeld(plan.contextHiddenAgents)
    panel.footer = panel.footer ? `${panel.footer} ${held}` : held
  }
  return panel
}

function panelTitle(mode, plan) {
  if (plan.showContext && plan.showRuns) return 'Your coordinator, and what has run here'
  if (plan.showContext) return 'Your coordinator'
  /* The example's list is the example fleet's, not this computer's, and the
     title says so beside the badge rather than borrowing the live one. */
  if (mode === HOME_MODES.SAMPLE) return 'Activity in this example fleet'
  return 'Activity on this computer'
}

/* THE FOOTER IS A WARNING OR NOTHING.
 *
 * It used to be three sentences on every healthy record: that the record checks
 * out, how many runs started, and that no ending is ever written down. The
 * owner, with the card in front of him (verbatim): "this little dialog box is
 * kind of pointless". He is right about the healthy case -- a paragraph that
 * says the same thing under every list is furniture, and the integrity
 * sentence was being read as a statement about the agents (it once sat under
 * three runs that all refused to start). So a record that checks out says
 * nothing, and only a record that NO LONGER checks out speaks, because that is
 * the one case where the sentence changes what a person should do with the
 * list. The outcome count is still on the metrics page through COPY.runOutcomes. */
function recordFooter(sessions) {
  if (sessions.verified === false) {
    return 'Written down on this computer as it happened. The record no longer checks out, so treat this list as a guide, not a receipt.'
  }
  return null
}

function panelStatements(panel) {
  const out = [panel.title]
  if (panel.badge) out.push(panel.badge)
  for (const notice of [panel.empty, panel.contextEmpty]) {
    if (!notice) continue
    out.push(notice.title, notice.body)
    if (notice.action) out.push(notice.action.label)
  }
  if (panel.footer) out.push(panel.footer)
  return out
}
