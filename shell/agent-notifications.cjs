'use strict'

/* THE NOTIFICATIONS THIS PRODUCT NEVER SENT.
 *
 * MEASURED before this file existed: the word `Notification` appeared ZERO
 * times in shell/ and in src/. Nothing in this product has ever raised one. An
 * agent could finish an hour of work, ask for permission and sit waiting, or
 * die on its second turn, and the only way to find out was to go and look. That
 * is not an unreliable notification; it is the absence of the whole idea.
 *
 * THE OWNER DECIDED HOW IT IS CONTROLLED, in these words: "settings -> all of
 * these are just settings a user picks". So every trigger below is a settings
 * row a person chooses, every row ships OFF, and this file READS THE ROW BEFORE
 * IT NOTIFIES. A row nothing reads is the defect this repository has already
 * recorded once at scale -- seventy-four settings that wrote a key nothing read
 * -- and tools/test/settings-rows-do-something.test.mjs names this file as the
 * reader for both of them. If that stops being true, that suite goes red.
 *
 * WHY THE ROW IS READ PER CALL AND NEVER CAPTURED. Same rule relayPrincipal()
 * states in shell/main.cjs: reading at construction would mean a switch turned
 * off at 10:00 keeps interrupting somebody until they restart the program. The
 * store is shell/renderer-prefs.cjs -- the durable settings file the settings
 * page already writes through `mc-prefs:write` -- so this is the SAME record
 * the switch on the screen shows, never a second copy that could disagree.
 *
 * OFF IS THE ABSENCE OF A KEY, AND THAT IS NOT AN ACCIDENT. The settings page
 * REMOVES a row's key when its value returns to the default (writeStored() in
 * src/views/settings.js), and the default here is off. So an unset key, a
 * damaged file, an unreadable file and an explicit "false" all answer the same
 * thing: do not interrupt this person. There is no path by which a settings
 * fault turns into an interruption.
 *
 * IT REFUSES BY NAME RATHER THAN DOING NOTHING QUIETLY. Every call answers
 * {delivered, reason}. `Notification.isSupported()` false is reported as its
 * own reason, not silence -- a notification nobody sees and nobody is told
 * about is the exact defect this repository keeps finding, and the settings
 * rows are DISABLED WITH THAT REASON BESIDE THEM on a computer that answers
 * false (src/notification-delivery.js draws it, shell/main.cjs answers it).
 *
 * THE HARD PART: NOT INTERRUPTING SOMEBODY WHO IS ALREADY LOOKING.
 *
 * A notification is suppressed only when BOTH of these hold:
 *
 *   1  this application's window has focus, which only the main process can
 *      know (BrowserWindow.isFocused), and
 *   2  the page has said that the session on screen is the session this event
 *      came from.
 *
 * NEITHER HALF IS ENOUGH ALONE, and both alternatives were considered and
 * rejected for a stated reason. Focus alone would silence the case that matters
 * most: this product has twelve stops and eleven of them are not an agent
 * transcript, so somebody reading the Ledger with the window right in front of
 * them would be told nothing when the agent behind it stopped -- and the whole
 * point of a notification is that you are not on that screen. The page's report
 * alone would notify nobody about a window sitting open behind a browser, which
 * is where this product spends most of a working day. The PAIR is what "already
 * looking at it" means, and it is the only reading of it a computer can check.
 *
 * WHEN IN DOUBT IT NOTIFIES. No report from the page, a report about another
 * session, a window that is gone: all of those deliver. The page re-reports on
 * every navigation and on every change of the running session, so a stale
 * report means the screen did not change. An extra notification is a nuisance;
 * a missing one is the defect this file was written to remove.
 *
 * THE TWO ENDINGS, AND WHY THE ROW WOULD HAVE BEEN HALF TRUE WITH ONLY ONE.
 *
 * "Tell me when an agent stops with a problem" was wired, on the day it landed,
 * to `turn_completed` alone. shell/main.cjs names the other ending eleven lines
 * below that caller -- "THE CHILD'S OWN EXIT, the second genuine ending" -- and
 * nothing on it notified. So an engine child that died BETWEEN prompts, or was
 * killed, or ran the machine out of memory while nobody was mid-turn, produced
 * an audit line and complete silence. A person reading that row could not work
 * out which half they had bought, which is the drawn-control shape this
 * repository has already recorded at scale.
 *
 * Both endings arrive here now: turn events through consider(), and the host's
 * own exit report through considerSessionEnd(). They resolve to the SAME row
 * and the same words, because from the person's side they are one fact.
 *
 * ONE STOP MUST NOT ARRIVE TWICE, AND THE TWO ENDINGS OVERLAP ON PURPOSE. A
 * child that dies WHILE A TURN IS RUNNING produces both: shell/agent-host.cjs
 * turns the turn's rejection into a synthetic `turn_completed{status:'failed'}`
 * so the surface is not left waiting, and observeEngineExit() reports the same
 * death a moment later. Left alone that is two toasts for one stop.
 *
 * So a session somebody was ACTUALLY TOLD had stopped is REMEMBERED, and the
 * second ending for it answers `this-stop-was-already-reported` instead of
 * raising anything. Told, rather than merely decided about: a stop that reached
 * a switched-off row or a person who was watching at that instant reached
 * nobody, and swallowing the ending behind it would turn one silence into two.
 *
 * The memory is cleared by a SUCCESSFUL turn, because an agent that has
 * answered since is demonstrably running again and its next stop is a new one.
 *
 * The remaining gap is stated rather than hidden: an agent that reports a
 * failed turn, keeps running, and dies later without answering anything in
 * between is told once, not twice. It was already told to the person as stopped
 * and has not been seen working since, so the row's promise is kept.
 */

/* THE TRIGGERS, EACH WITH THE SETTINGS ROW THAT DECIDES IT.
 *
 * `settingId` is the row id in src/views/settings.js and `key` is the store key
 * that row writes -- `mc.set.` + the id, which is storageKey() there. They are
 * spelled out rather than derived so a reader can see both halves at once, and
 * tools/test/agent-notifications.test.mjs asserts the pair agrees with the page
 * for every trigger, so the two files cannot drift.
 *
 * The words are what a person reads on the corner of their screen with no
 * context around them, so each title says what happened and each body says
 * where to go. None of them carries a path, a session id or an engine word.
 *
 * THE WORDS ARE CONSTANT, AND WHICH AGENT IT WAS IS DELIBERATELY NOT IN THEM.
 * Three agents finishing produce three identical notifications, which is worse
 * for telling them apart and is the trade this product has already made in
 * writing: the risk statement on both rows in src/permission-guidance.js says
 * the notification appears on whatever screen a person is sharing, and that it
 * says only that an agent finished. An agent's name is a project's name often
 * enough that putting it on a projector is a different product decision from
 * the one shipped here, and it is the owner's to make, not this file's. The
 * body answers it the way the design intends: open ToolsEnabled, where all
 * three are on one screen with their names.
 *
 * COLLAPSING THEM INTO ONE IS NOT AVAILABLE RATHER THAN NOT WANTED. Electron's
 * Notification takes no tag or replaces-id, so there is no cross-platform way
 * to ask the operating system to fold repeats together. What the list of them
 * looks like once Windows has collected them has not been measured.
 *
 * THERE IS NO "AN AGENT NEEDS APPROVAL" TRIGGER, AND ITS ABSENCE IS A
 * MEASUREMENT RATHER THAN AN OVERSIGHT.
 *
 * It was the obvious third one, and it was written and then removed. The
 * contract has the event -- `approval_request`, which the renderer already
 * reads (src/agent-session-events.js) and which this shell can already answer
 * (`mc-agent:approval-answer`). What it does not have is anything that RAISES
 * one: shell/agent-host.cjs states, at answerApproval(), that approvalPolicy is
 * `never` at every tier and that no approval fires today, and that the answer
 * path was landed first on purpose because the day one fired with no answer
 * path the turn would hang forever.
 *
 * So a switch for it would move, save, survive a restart and never once produce
 * a notification -- which is precisely the drawn-control defect this product
 * has already shipped seventy-four instances of, and the reason
 * tools/test/settings-rows-do-something.test.mjs exists. A control that cannot
 * succeed is disabled with the reason beside it; a control for an event this
 * build cannot produce AT ALL is not a disabled control, it is a control for a
 * feature that is not here. It is not hidden either: the Notifications section
 * on the settings page says in its own note that agents on this computer never
 * stop to ask permission, so a person looking for that switch is told why it is
 * not there instead of hunting for it.
 *
 * WHAT HAS TO BE TRUE FOR IT TO ARRIVE: a level whose approvalPolicy can ask.
 * On the day 'on-request' is offered, this table gains an 'agent-approval'
 * entry, triggerForEvent() gains one line for `approval_request`, and the
 * settings page gains its third row -- in that same edit, not before it. */
const TRIGGERS = Object.freeze({
  'agent-finished': Object.freeze({
    id: 'agent-finished',
    settingId: 'notify_agent_finished',
    key: 'mc.set.notify_agent_finished',
    title: 'An agent finished',
    body: 'An agent you started has finished its turn. Open ToolsEnabled to read what it did.',
  }),
  'agent-error': Object.freeze({
    id: 'agent-error',
    settingId: 'notify_agent_error',
    key: 'mc.set.notify_agent_error',
    title: 'An agent stopped',
    body: 'An agent stopped before it finished. Open ToolsEnabled to read what it said.',
  }),
})

/* WHOSE WORD FOR "IT WENT WELL" COUNTS, and this list is a COPY of one that
 * already exists -- TURN_SUCCESS_STATUSES in src/agent-session-events.js. It is
 * copied rather than imported because that file is an ES module the renderer
 * loads and this one is required by the main process; there is no import that
 * crosses that line in this tree. A copy is a second opinion waiting to happen,
 * so tools/test/agent-notifications.test.mjs reads the list back out of that
 * source and fails if the two ever differ.
 *
 * IT IS AN ALLOWLIST AND IT FAILS CLOSED, for the reason stated where the
 * original lives: codex says "completed", the Claude CLI says "success", and
 * anything an engine adds later is NOT-success until somebody measures it. Here
 * that means an unrecognised ending is offered to the "an agent stopped" row
 * rather than the "an agent finished" one -- and since both rows ship off, an
 * unknown word can only ever reach somebody who asked to hear about stops. */
const TURN_SUCCESS_STATUSES = Object.freeze(['completed', 'success', 'end_turn'])

/* The same default src/agent-session-events.js applies in sessionTurnStatus():
   a completion that carries no status word is a completed turn. Pinned against
   that source by the same suite, for the same reason as the list above. */
const MISSING_TURN_STATUS = 'completed'

/* WHICH TRIGGER MEANS "THIS AGENT STOPPED". Named once because four things have
   to agree on it -- the table, each of the two endings, and the memory that
   keeps them from doubling -- and a string typed four times is four chances to
   disagree. */
const STOP_TRIGGER_ID = 'agent-error'

const REASON = Object.freeze({
  delivered: 'delivered',
  notATrigger: 'not-a-notifying-event',
  switchedOff: 'switched-off',
  unsupported: 'this-computer-shows-no-notifications',
  alreadyWatching: 'already-on-screen',
  alreadyReported: 'this-stop-was-already-reported',
  showFailed: 'the-notification-could-not-be-shown',
})

/** The trigger an agent event asks for, or null when the event is not one. */
function triggerForEvent(event) {
  if (!event || typeof event !== 'object') return null
  if (event.type !== 'turn_completed') return null
  const status = typeof event.status === 'string' ? event.status : MISSING_TURN_STATUS
  return TURN_SUCCESS_STATUSES.includes(status)
    ? TRIGGERS['agent-finished']
    : TRIGGERS[STOP_TRIGGER_ID]
}

/* THE SECOND ENDING'S TRIGGER, and there is only one it can be.
 *
 * The host reports an exit ONLY for a child that went away without being asked
 * -- observeEngineExit() suppresses the exit that follows closeSession() and
 * closeAll(), because that ending is the person's own Stop and they already
 * know. So every report that reaches here is an agent that stopped before it
 * finished, whatever exit code it carried. The code and the signal are
 * deliberately not read: they would only ever choose between two words for the
 * same fact, and neither word is in the notification anyway. */
function triggerForSessionExit(report) {
  if (!report || typeof report !== 'object') return null
  return TRIGGERS[STOP_TRIGGER_ID]
}

/* HOW MANY ENDED SESSIONS ARE REMEMBERED AT ONCE, so a process that has been
   up for a month is not holding every session id it ever saw. The two endings
   of one stop arrive milliseconds apart, so forgetting the oldest can only
   matter if this many OTHER sessions ended in between, which is not a shape
   this product has. Oldest out first, which is insertion order for a Set. */
const MAX_REMEMBERED_STOPS = 256

function answer(delivered, reason, trigger) {
  return Object.freeze({ delivered, reason, trigger: trigger ? trigger.id : null })
}

/**
 * The seam.
 *
 * @param options.notifications  the platform. `{ isSupported(), show({title, body}) }`.
 *        shell/main.cjs builds this from Electron's own Notification; the tests
 *        hand it a recorder, which is the only reason it is a parameter.
 * @param options.prefs  the durable settings store -- `{ snapshot() }`, which is
 *        what shell/renderer-prefs.cjs returns. Asked on every call.
 * @param options.attention  `() => ({ focused, sessionId })`: does this
 *        application have focus, and which session did the page last say is on
 *        screen. A function, not a value, for the same reason the row is: it
 *        has to be true NOW, not at construction.
 */
function createAgentNotifier({ notifications, prefs, attention }) {
  if (!notifications || typeof notifications.isSupported !== 'function' || typeof notifications.show !== 'function') {
    throw new TypeError('createAgentNotifier requires notifications with isSupported() and show()')
  }
  if (!prefs || typeof prefs.snapshot !== 'function') {
    throw new TypeError('createAgentNotifier requires a settings store with snapshot()')
  }
  if (typeof attention !== 'function') {
    throw new TypeError('createAgentNotifier requires an attention function')
  }

  /* THE SESSIONS ALREADY REPORTED STOPPED, so one stop cannot arrive twice.
     Insertion-ordered and bounded; see MAX_REMEMBERED_STOPS and the header. */
  const stopReported = new Set()

  function usableSessionId(sessionId) {
    return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null
  }

  /* A REPORT WITH NO SESSION ID CANNOT BE REMEMBERED, AND SO IS NEVER SILENCED.
     It is the same rule as everywhere else in this file: doubt notifies. The
     cost is that a nameless ending could in principle be told twice; the cost
     of the other choice is a stop nobody hears about. */
  function stopAlreadyReported(sessionId) {
    const id = usableSessionId(sessionId)
    return id !== null && stopReported.has(id)
  }

  function rememberStop(sessionId) {
    const id = usableSessionId(sessionId)
    if (id === null) return
    stopReported.add(id)
    while (stopReported.size > MAX_REMEMBERED_STOPS) {
      const oldest = stopReported.values().next()
      if (oldest.done) break
      stopReported.delete(oldest.value)
    }
  }

  /* AN AGENT THAT HAS ANSWERED SINCE IS RUNNING AGAIN, so its next stop is a
     new one and must be told. This is the only thing that clears the memory. */
  function forgetStop(sessionId) {
    const id = usableSessionId(sessionId)
    if (id !== null) stopReported.delete(id)
  }

  /* THE ROW, READ NOW. An unreadable store answers off -- see the header. */
  function switchedOn(trigger) {
    let values
    try { values = prefs.snapshot().values } catch { return false }
    if (!values || typeof values !== 'object') return false
    return values[trigger.key] === 'true'
  }

  function watching(sessionId) {
    let now
    try { now = attention() } catch { return false }
    if (!now || typeof now !== 'object') return false
    if (now.focused !== true) return false
    return typeof sessionId === 'string' && sessionId.length > 0 && now.sessionId === sessionId
  }

  /* THE PLATFORM, ASKED THE SAME WAY EVERYWHERE. Declared in the closure and
     not as a method on the returned object, along with deliver() below, because
     a caller that destructures -- `const { deliver } = notifier` -- would
     otherwise get a function whose `this` is undefined, and the first thing it
     does is ask whether this computer can show a notification. A seam that
     breaks depending on how it was reached is a seam that fails on the day
     somebody tidies a call site. */
  function supported() {
    try { return notifications.isSupported() === true } catch { return false }
  }

  /**
   * Raise one notification for one trigger, or say why not.
   *
   * The order of the checks is deliberate and is the order a reader would ask
   * them in: is this a thing we notify about, did the person ask for it, can
   * this computer do it at all, and are they already looking at it.
   *
   * KEEPING THE TWO ENDINGS FROM DOUBLING IS NOT DONE HERE. It belongs to
   * considerEnding(), which both product callers go through; a caller that
   * reaches this function directly is asking for exactly one notification about
   * one trigger and gets exactly that.
   */
  function deliver({ trigger, sessionId = null } = {}) {
    /* RESOLVED FROM THE TABLE BY ID, NEVER TAKEN FROM THE CALLER. A caller may
       NAME a trigger; it may not BE one. Reading the key and the words off a
       caller-supplied object would let a caller hand over its own storage key
       -- one nothing on the settings page writes, and so one nobody can switch
       off -- and its own sentences. So the id is the only thing that crosses,
       and everything the notification is made of comes from TRIGGERS above. */
    const named = typeof trigger === 'string'
      ? trigger
      : (trigger && typeof trigger === 'object' && typeof trigger.id === 'string' ? trigger.id : null)
    const chosen = named && Object.prototype.hasOwnProperty.call(TRIGGERS, named) ? TRIGGERS[named] : null
    if (!chosen) return answer(false, REASON.notATrigger, null)
    if (!switchedOn(chosen)) return answer(false, REASON.switchedOff, chosen)
    if (!supported()) return answer(false, REASON.unsupported, chosen)
    if (watching(sessionId)) return answer(false, REASON.alreadyWatching, chosen)
    try {
      notifications.show({ title: chosen.title, body: chosen.body })
    } catch {
      /* A notification that could not be raised must never be able to stop an
         agent from working: this is called from the event fan-out that also
         feeds the transcript. Reported, not thrown. */
      return answer(false, REASON.showFailed, chosen)
    }
    return answer(true, REASON.delivered, chosen)
  }

  /* THE ONE ROUTE BOTH ENDINGS TAKE.
   *
   * This is what makes "one stop, one notification" a property of this file
   * rather than an agreement between its two callers. Neither consider() nor
   * considerSessionEnd() can reach the platform without passing through here,
   * so a third caller added later inherits the rule instead of re-inventing it.
   *
   * A STOP IS REMEMBERED ONLY WHEN SOMEBODY WAS ACTUALLY TOLD ABOUT IT, which
   * is what makes the rule "one stop, one notification" rather than "one stop,
   * one decision". The difference is a real hole: a stop that reached a
   * switched-off row, a platform that refused, or somebody who was watching at
   * that instant told NOBODY -- and if that had counted, the second ending
   * arriving a moment later would have been swallowed too, leaving a person who
   * switched the row on between the two, or who walked away from the screen,
   * with nothing at all.
   *
   * The clearing is the other way round and is not about notifications at all:
   * a SUCCESSFUL turn clears the memory whether or not anyone was told, because
   * what it proves is that the agent is running again. */
  function considerEnding(chosen, sessionId) {
    if (chosen.id !== STOP_TRIGGER_ID) {
      forgetStop(sessionId)
      return deliver({ trigger: chosen, sessionId })
    }
    if (stopAlreadyReported(sessionId)) return answer(false, REASON.alreadyReported, chosen)
    const outcome = deliver({ trigger: chosen, sessionId })
    if (outcome.delivered === true) rememberStop(sessionId)
    return outcome
  }

  /** The whole decision for one packet off the agent event stream. */
  function consider(packet) {
    if (!packet || typeof packet !== 'object') return answer(false, REASON.notATrigger, null)
    const chosen = triggerForEvent(packet.event)
    if (!chosen) return answer(false, REASON.notATrigger, null)
    return considerEnding(chosen, typeof packet.sessionId === 'string' ? packet.sessionId : null)
  }

  /**
   * The whole decision for the SECOND ending: the engine child is gone.
   *
   * @param report  the host's own exit report, `{ sessionId, exit }`. The exit
   *                code is not read; see triggerForSessionExit().
   */
  function considerSessionEnd(report) {
    const chosen = triggerForSessionExit(report)
    if (!chosen) return answer(false, REASON.notATrigger, null)
    return considerEnding(chosen, typeof report.sessionId === 'string' ? report.sessionId : null)
  }

  return Object.freeze({ supported, deliver, consider, considerSessionEnd })
}

/* ---------------------------------------------------------------
   THE THREE HOPS BETWEEN THIS SEAM AND THE PERSON.
   ---------------------------------------------------------------

   Everything above is reachable by `node --test`. Everything that used to sit
   BETWEEN it and a real notification was not: the answer the page gets when it
   asks whether this computer can show one, the bound on the session id the page
   reports, and the reading of "does this window have focus". Each was a couple
   of expressions inside an Electron handler in shell/main.cjs, where the only
   guard a suite can offer is a source pin -- and a source pin catches the
   DELETION of a line and nothing at all about what the line does. A review of
   this lane mutated exactly those expressions and the whole suite stayed green.

   So the DECISIONS moved here, where a test can drive them with a plain object,
   and shell/main.cjs keeps only what is genuinely a fact about Electron: which
   frame sent the message, and which window object is the current one. That is
   the same division shell/agent-command-surface.cjs already makes for every
   agent command, for the same reason. */

/**
 * The answer to "can this computer show a notification at all", for the page.
 *
 * @param trusted  did this question come from our own main frame. Anything
 *                 other than the word true is answered no, which draws the
 *                 disabled switch -- the same thing an unanswerable question
 *                 gets, and never an enabled one.
 * @param ask      `() => boolean`, the seam's own supported(). Called only for
 *                 a trusted sender, and a throw from it is answered no: an
 *                 answer we could not establish is not "it works".
 */
function deliveryAnswerFor(trusted, ask) {
  if (trusted !== true) return Object.freeze({ supported: false })
  let supported = false
  try { supported = ask() === true } catch { supported = false }
  return Object.freeze({ supported })
}

/**
 * The session id a page's "this is what I am showing" report may set, or null.
 *
 * Null is the ordinary answer and it means "nothing on screen", which DELIVERS.
 * So every malformed shape resolves to null on purpose: a missing field, a
 * wrong type, an empty string and an over-long string all buy a notification
 * rather than silence. A report that cannot be trusted must never be able to
 * buy quiet, because silence is the failure this whole feature removes.
 *
 * @param maxLength  the same bound every other session id on this boundary
 *                   carries (MAX_SESSION_ID_LENGTH in shell/main.cjs). Passed
 *                   in rather than duplicated so the two cannot drift.
 */
function watchedSessionFrom(value, maxLength) {
  if (!value || typeof value !== 'object') return null
  const sessionId = value.sessionId
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null
  if (!Number.isInteger(maxLength) || maxLength <= 0) return null
  return sessionId.length <= maxLength ? sessionId : null
}

/**
 * What the notifier is told when it asks who is paying attention.
 *
 * @param window     the current BrowserWindow, or null. Asked at the moment of
 *                   the event and never remembered: a window that is gone,
 *                   minimised or behind something else answers false, and false
 *                   means the person is told.
 * @param sessionId  what the page last said it is showing.
 *
 * A window that throws on either question is treated as not focused, for the
 * same reason as everything else here: doubt notifies. So is one that answers
 * either question with anything but the word it was asked for -- "not the word
 * false" is not the same as "still alive", and the difference between those two
 * readings is a person not being told their agent stopped.
 */
function attentionNow(window, sessionId) {
  let focused = false
  try { focused = Boolean(window) && window.isDestroyed() === false && window.isFocused() === true } catch { focused = false }
  return Object.freeze({ focused, sessionId: typeof sessionId === 'string' && sessionId ? sessionId : null })
}

module.exports = {
  MAX_REMEMBERED_STOPS,
  MISSING_TURN_STATUS,
  REASON,
  STOP_TRIGGER_ID,
  TRIGGERS,
  TURN_SUCCESS_STATUSES,
  attentionNow,
  createAgentNotifier,
  deliveryAnswerFor,
  triggerForEvent,
  triggerForSessionExit,
  watchedSessionFrom,
}
