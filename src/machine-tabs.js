/* WHICH OF YOUR COMPUTERS THIS BROWSER IS DRIVING -- the choice, moved into
 * the application.
 *
 * THE RULING (owner, 2026-08-23, on two screenshots of the account page's rows
 * and the computers page's tab bar): "rather than selecting what computer they
 * drive here (1) it should be added here (2) to page2 and either machine should
 * be driveable once connected." It completes an earlier one: "If there's only
 * one computer connected we need to serve that one computer in the interface.
 * If there's two we need to serve both in the interface and both need to be
 * controllable."
 *
 * So a person driving their machine from a browser somewhere else picks which
 * machine on the page they are already on, and does not have to leave for the
 * account page and come back. The account page's rows STAY: they carry
 * Disconnect and the awake-or-asleep line, which this bar does not.
 *
 * TWO DIFFERENT AXES SHARE ONE BAR, AND CONFLATING THEM WOULD BE THE DEFECT.
 *
 *   THE COMPUTERS ON YOUR ACCOUNT -- this file. Each one is a whole machine,
 *   reached over a separate tunnel; changing which one you drive changes where
 *   every reading on every screen comes from. The identity is a pair of ids the
 *   account issued, and the name is the account's.
 *
 *   THE COMPUTERS INSIDE ONE MACHINE'S RECORD -- src/views/computers.js's own
 *   `liveComputers`, which existed first. Those are entries in the fleet record
 *   that ONE machine reports; switching between them re-mounts a graph and
 *   reaches nothing new. The identity is a record id and the name is the
 *   record's.
 *
 * Nothing here reads or writes the other axis, and the view draws them as two
 * groups so a press can never mean the wrong one.
 *
 * IT HOLDS NO DOM. The surface it feeds is a view module the size of a small
 * program, and a rule that can only be checked by matching source text is a
 * rule that can silently stop existing. Every decision below is proven by
 * calling a function with a value. Its one import re-reads bridge refusals for
 * the browser reader rather than handing that reader instructions written for
 * the driven computer's desk.
 *
 * WHERE THE FACTS COME FROM. The website's host bridge publishes them on
 * `window.mcAccount` and has done since before this file existed:
 * `machines()` lists the account's connections and the computers in them,
 * `machineInUse()` answers which computer this tab will actually dial,
 * `checkMachine()` asks a computer whether it is awake, and `chooseMachine()`
 * validates a choice against the account, closes the tunnel belonging to the
 * old answer and remembers the new one for this tab only. Nothing in this file
 * re-derives any of those rules; a second copy of "which computer is this tab
 * pointed at" is how a page ends up claiming one machine while the tunnel
 * dials another.
 *
 * NO NAME IS EVER INVENTED HERE. A computer is called what the account calls
 * it, and a half the account has no name left for is a computer that has been
 * removed from it -- not a computer with a placeholder name. Those are left out
 * of the bar rather than given words; see machineTabRows.
 */

import { readerRemedy } from './refusal-copy.js'
import { DATA_SOURCE_EVENT } from './data-source.js'

export const MACHINE_CHOICE_INTENT_EVENT = 'mc:machine-choice-intent'
const switches = new WeakMap()
let nextSwitch = 0
const emptySwitch = Object.freeze({ busy: false, sentence: '' })

/* A switch belongs to this window, not the view that happened to receive the
   press. The shell replaces that view on both choose and rollback. Nothing
   here is persisted or grants machine authority: the bridge still owns that. */
function switchFor(scope) {
  let held = switches.get(scope)
  if (held) return held
  held = { active: null, result: null, resultBridge: null, state: emptySwitch, listeners: new Set() }
  held.publish = state => {
    held.state = Object.freeze(state)
    for (const listener of held.listeners) listener(held.state)
  }
  held.cancel = () => { held.active = null; held.result = null; held.resultBridge = null; held.publish(emptySwitch) }
  const ownIntent = detail => held.active && detail?.machineChoiceIntent === held.active.intent
  const expectedTarget = detail => held.active?.expected
    && detail?.relayPairId === held.active.expected.relayPairId
    && detail?.devicePairId === held.active.expected.devicePairId
  scope.addEventListener?.(MACHINE_CHOICE_INTENT_EVENT, event => {
    const expected = held.active?.expected
    /* A token correlates the prepared call, not every later call that reuses
       it. Only prepare() may open another intent/commit pair for rollback. */
    if (!ownIntent(event.detail) || !expectedTarget(event.detail) || expected.intentObserved) held.cancel()
    else expected.intentObserved = true
  })
  scope.addEventListener?.(DATA_SOURCE_EVENT, event => {
    const detail = event.detail
    if (detail?.why === 'agent-events-gap') return
    const expected = held.active?.expected
    if (ownIntent(detail) && expectedTarget(detail) && detail.why === expected.why
        && expected.intentObserved && !expected.observed) {
      expected.observed = true
      return
    }
    held.cancel()
  })
  switches.set(scope, held)
  return held
}

export function machineTabSwitchState(scope) { return switchFor(scope).state }

/* A completion can be superseded between resolving its promise and the view's
   continuation. Check at consumption, not only inside the async controller. */
export function machineTabSwitchResultIsCurrent(scope, result) {
  const held = switchFor(scope)
  return held.result === result && held.resultBridge === machineTabsBridge(scope)
}

export function subscribeMachineTabSwitch(scope, listener) {
  const held = switchFor(scope)
  held.listeners.add(listener)
  listener(held.state)
  return () => held.listeners.delete(listener)
}

/** The mounted UI path requires explicit intent events. An older bridge still
 * has its existing low-level choice API, but cannot promise ownership across
 * view replacements and concurrent choices. Leave that source unchanged. */
export async function switchMachineTab(scope, row, { previous = null } = {}) {
  const held = switchFor(scope)
  if (held.active) return { ok: false, cancelled: true }
  held.result = null
  held.resultBridge = null
  const bridge = machineTabsBridge(scope)
  if (bridge?.machineChoiceIntentVersion !== 1) {
    const result = { ok: false, sentence: 'This account connection cannot safely switch computers here yet. Reload the page, or choose the computer on your account page.' }
    held.result = result
    held.resultBridge = bridge
    held.publish({ busy: false, sentence: result.sentence })
    return result
  }
  const transaction = { intent: `machine-switch-${++nextSwitch}`, expected: null }
  held.active = transaction
  held.publish({ busy: true, sentence: `Opening ${row?.name || 'computer'}…` })
  const current = () => {
    if (held.active !== transaction) return false
    if (machineTabsBridge(scope) !== bridge) { held.cancel(); return false }
    return true
  }
  const prepare = target => {
    transaction.expected = target
      ? { why: 'machine-chosen', relayPairId: target.relayPairId, devicePairId: target.devicePairId, intentObserved: false, observed: false }
      : { why: 'machine-forgotten', relayPairId: null, devicePairId: null, intentObserved: false, observed: false }
    return { machineChoiceIntent: transaction.intent }
  }
  if (!current()) return { ok: false, cancelled: true }
  const result = await driveMachineTab(scope, row, { previous, transaction: {
    current, prepare,
    committed: () => current() && transaction.expected?.observed === true,
  } })
  if (!current()) return { ok: false, cancelled: true }
  held.active = null
  held.result = result
  held.resultBridge = bridge
  held.publish({ busy: false, sentence: result.cancelled ? '' : result.sentence || '' })
  return result
}

/* A COMPUTER THAT CANNOT BE DRIVEN, AND THE CONTROL THAT MAKES IT POSSIBLE
 * AGAIN. Each of these is a state the ACCOUNT reports, not a guess, and each
 * ends at a control: a failure that names nothing to do is the dead end this
 * product's copy gate exists to stop.
 *
 * The states are the bridge's own words for what the account server said:
 *
 *   a removed partner   the connection still exists and cannot carry anything,
 *                       because the computer at its other end is gone.
 *   never finished      the computer was added but never picked up what it was
 *                       granted, and what it needed has run out. It can never
 *                       answer, and it looks exactly like a machine that is
 *                       switched off, which is why this is said out loud.
 *   still finishing     the same thing, early enough that it can still succeed.
 *                       Weaker on purpose: this is also what is reported when
 *                       how long it has been is not known.
 */
export const MACHINE_TAB_PARTNER_REMOVED = 'The other computer in this connection was removed, so this one cannot be '
  + 'reached through it. Connect it again on your account page.'
export const MACHINE_TAB_NEVER_FINISHED = 'That computer never finished connecting, so it can never answer. Remove it '
  + 'and add it again on your account page, with ToolsEnabled open on it this time.'
export const MACHINE_TAB_STILL_FINISHING = 'That computer has not finished connecting yet. It finishes the next time it '
  + 'is running ToolsEnabled, which normally takes a few seconds. Open ToolsEnabled on it and press this again.'

/* THE PRESS FAILED, IN THE THREE WAYS THAT ARE NOT THE ACCOUNT'S OWN REFUSAL.
 * The bridge writes its own refusals for a person and they are forwarded
 * verbatim; these cover the gaps where there is no bridge sentence to forward. */
export const MACHINE_TAB_NO_BRIDGE = 'This page cannot change which of your computers it is reading. Open '
  + 'toolsenabled.ai in a browser and sign in to choose one there.'
export const MACHINE_TAB_NOT_CHOSEN = 'That computer could not be chosen, and nothing here changed. Try again in a moment.'
export const MACHINE_TAB_NOT_ASKED = 'We could not find out whether that computer is awake, so nothing here was '
  + 'changed. Try again in a moment.'
export const MACHINE_TAB_NOT_CHECKED = 'This copy switched computers but has no way to check whether the other '
  + 'computer is awake. The page will now show what it can read.'

/* WHERE THE PERSON IS STANDING AFTER A PRESS THAT DID NOT WORK. The rule the
   whole file is built around: a press that cannot reach a machine leaves them
   on the machine they were already driving, and says so. */
export function machineTabStaysOn(previous) {
  if (previous && typeof previous.name === 'string' && previous.name) return `You are still driving ${previous.name}.`
  return 'No computer is chosen now, so pick one here once it is awake.'
}

export const MACHINE_TAB_NOT_PUT_BACK = 'We could not put you back on the computer you were driving. Reload this page '
  + 'to start again.'

/* The bridge, and only if it can do BOTH halves of this job. A host that lists
   computers but cannot be told which to drive would draw a bar of controls that
   refuse -- feature-detected the way src/account-state.js detects the sign-in
   bridge, and for the same reason. */
export function machineTabsBridge(scope = globalThis) {
  const bridge = scope?.mcAccount
  if (!bridge || typeof bridge.machines !== 'function' || typeof bridge.chooseMachine !== 'function') return null
  return bridge
}

const named = value => typeof value === 'string' && value.length > 0

/* WHY A COMPUTER CANNOT BE DRIVEN, or null when it can.
 *
 * The rule is the account page's, asked the same way rather than restated: a
 * connection with a removed computer in it carries nothing, and a computer that
 * never collected what it was granted cannot answer however awake it is. Every
 * other reading -- including "we could not read the collection state at all" --
 * leaves the computer offered, because not knowing something about a machine is
 * a fact about us and is never grounds for telling somebody their computer is
 * broken. */
export function machineTabTrouble(pair, half) {
  if (pair?.connected !== true) return MACHINE_TAB_PARTNER_REMOVED
  if (half?.collection === 'never-collected') return MACHINE_TAB_NEVER_FINISHED
  if (half?.collection === 'waiting' || half?.collection === 'uncollected') return MACHINE_TAB_STILL_FINISHING
  return null
}

/**
 * One row per computer on the account, from `machines()` and `machineInUse()`.
 *
 * `inUse` is the bridge's answer to "which computer will this tab actually
 * dial" and it is NOT the same question as "which one did somebody choose": a
 * person with a single connected computer has chosen nothing and is driving it
 * all the same. Asked of the bridge rather than worked out here, so this bar
 * and the tunnel cannot disagree. When it could not be asked, each half's own
 * `chosen` flag is the weaker fallback.
 *
 * A refusal, an absent list or a shape this does not recognise all produce an
 * empty list, which the view draws as the bar it had before. There is no path
 * here that turns a failure into a computer.
 */
export function machineTabRows(listed, inUse = null) {
  if (!listed || listed.ok !== true || !Array.isArray(listed.machines)) return []
  /* Both ids have to agree or neither does: the other half of one connection is
     a different computer. A half-answer -- a connection with no computer named
     inside it -- cannot mark a row, so it marks none. */
  const pointed = inUse && named(inUse.relayPairId) && named(inUse.devicePairId) ? inUse : null
  const rows = []
  for (const pair of listed.machines) {
    if (!pair || !named(pair.relayPairId)) continue
    const halves = Array.isArray(pair.machines) ? pair.machines : []
    for (const half of halves) {
      if (!half || !named(half.pairId)) continue
      /* A NAMELESS HALF IS NOT LISTED. It is the computer that was REMOVED from
         the account, and it is the only row here that is not a computer a
         person has -- drawing a chip called "a computer that was removed" would
         put a control in the bar whose only possible outcome is a sentence. The
         computer that SURVIVES the same connection is listed, and its row is
         what says what happened to the other one. */
      if (!named(half.name)) continue
      rows.push(Object.freeze({
        relayPairId: pair.relayPairId,
        devicePairId: half.pairId,
        name: half.name,
        driving: pointed
          ? pointed.relayPairId === pair.relayPairId && pointed.devicePairId === half.pairId
          : half.chosen === true,
        trouble: machineTabTrouble(pair, half),
      }))
    }
  }
  return rows
}

/**
 * WHAT THE TAB BAR CONTAINS — decided here, with no document in the room.
 *
 * The bar carries chips from two different axes (see the header) and the whole
 * risk in drawing them together is drawing the wrong ones. So the decision is a
 * function of two numbers and can be called with a value:
 *
 *   NO ACCOUNT COMPUTERS — the desktop application, and a browser showing the
 *   example — draws the record's own tabs and nothing else, at every record
 *   size. That is the bar this page has always had, and this is the branch that
 *   keeps it exactly.
 *
 *   ACCOUNT COMPUTERS, ONE RECORD COMPUTER OR NONE — the ordinary shape of a
 *   machine driven from a browser. The record's single computer IS the machine
 *   already named by its own chip, so drawing it again would put two chips on
 *   one machine and call one of them "This computer" while the person is
 *   somewhere else entirely.
 *
 *   ACCOUNT COMPUTERS AND A RECORD THAT REALLY HOLDS SEVERAL — both groups,
 *   with a hairline between them, because both now offer a choice and a
 *   continuous run of identical chips would read as one list.
 */
export function machineTabsBar(machineRows, recordCount = 0) {
  const machines = Array.isArray(machineRows) ? machineRows : []
  const record = machines.length === 0 || recordCount > 1
  return Object.freeze({ machines, separator: machines.length > 0 && record, record })
}

/** Read the account's computers. Never throws; a host that refuses, a browser
 *  with nobody signed in, and a page with no bridge at all are all "no rows",
 *  which the view draws as the bar it already had. */
export async function readMachineTabs(scope = globalThis) {
  const bridge = machineTabsBridge(scope)
  if (!bridge) return { ok: false, rows: [] }
  let listed = null
  try { listed = await bridge.machines() } catch { return { ok: false, rows: [] } }
  if (!listed || listed.ok !== true) return { ok: false, rows: [] }

  let inUse = null
  if (typeof bridge.machineInUse === 'function') {
    try {
      const answer = await bridge.machineInUse()
      if (answer && named(answer.relayPairId)) {
        inUse = { relayPairId: answer.relayPairId, devicePairId: named(answer.devicePairId) ? answer.devicePairId : null }
      }
    } catch { /* the bar still draws; the fallback marks it from the account's own flag */ }
  }
  return { ok: true, rows: machineTabRows(listed, inUse) }
}

/* The refusal's own words when it left any, and this file's when it did not.
   The bridge writes its refusals for a person to read, so they are forwarded
   rather than paraphrased -- a paraphrase of "that connection holds two
   computers" is how a page ends up explaining the wrong problem. */
function reasonOf(answer, fallback) {
  const sentence = answer && typeof answer.reason === 'string' && answer.reason ? answer.reason : fallback
  return readerRemedy(sentence, { viaRelay: true })
}

/* IS IT ACTUALLY THERE. Nothing in the account's list can answer this: a name
   means the computer is still registered, never that the program is open on it.
   Asked AFTER the choice is stored, because that is when the bridge will open a
   tunnel to the new computer rather than a second one to the old.

   A host without the question is not a reason to refuse the press. It is an
   older or a smaller bridge, and refusing would take away a control that works;
   the page's own read is then what finds out, exactly as it did before this
   file existed. But a choice that could not be checked is not a checked
   success: its sentence survives so the caller can name the unknown state. */
async function machineAnswers(bridge, row) {
  if (typeof bridge.checkMachine !== 'function') return { ok: true, verified: false, sentence: MACHINE_TAB_NOT_CHECKED }
  let answer = null
  try { answer = await bridge.checkMachine(row.relayPairId, row.devicePairId) } catch {
    return { ok: false, sentence: MACHINE_TAB_NOT_ASKED }
  }
  if (answer && answer.ok === true) return { ok: true, verified: true, sentence: null }
  return { ok: false, sentence: reasonOf(answer, MACHINE_TAB_NOT_ASKED) }
}

/* PUT THE PERSON BACK. The choice is already stored by the time we find out the
   computer is silent, so leaving it would strand them: every screen would then
   be read from a machine that is not answering. Restoring is the same call that
   made the choice, aimed at the computer they had. */
async function putBack(bridge, previous, transaction) {
  if (!previous || !named(previous.relayPairId) || !named(previous.devicePairId)) {
    if (transaction && typeof bridge.forgetMachine !== 'function') return { failed: true }
    if (typeof bridge.forgetMachine === 'function') {
      try { await bridge.forgetMachine(transaction?.prepare(null)) } catch { /* the result below remains unconfirmed */ }
      if (transaction && !transaction.current()) return { cancelled: true }
      if (transaction && !transaction.committed()) return { failed: true }
    }
    return { restored: false }
  }
  let answer = null
  try { answer = await bridge.chooseMachine({ relayPairId: previous.relayPairId, devicePairId: previous.devicePairId, ...transaction?.prepare(previous) }) } catch {
    return { restored: false, failed: true }
  }
  if (transaction && !transaction.current()) return { cancelled: true }
  if (answer?.ok === true && transaction && !transaction.committed()) return { restored: false, failed: true }
  if (answer && answer.ok === true) return { restored: true }
  return { restored: false, failed: true }
}

/**
 * Drive another computer.
 *
 * `row` is one of `machineTabRows`'s, `previous` is the row they are on now.
 * Returns `{ ok, sentence }`: `ok` true means the choice stands, while
 * `verified` says whether the machine itself answered. An unverified success
 * carries the unknown-state sentence for the caller to keep visible. `ok`
 * false means the caller must leave the screen alone and print the sentence,
 * which is always the truest available account of what happened.
 *
 * THE ORDER IS THE WHOLE DESIGN.
 *
 *   1. A computer the account has already told us cannot be driven is refused
 *      HERE, with the account's reason, before anything is called. Pressing it
 *      would spend eight seconds and come back with the wrong answer -- "your
 *      computer did not answer" about a computer that is sitting there switched
 *      on, which is the mistake the account page's own rows exist to avoid.
 *   2. The choice is made. Every refusal `chooseMachine` has happens before it
 *      touches anything, so a refused press leaves the tab exactly as it was.
 *   3. The computer is asked whether it is awake. A silent one is put back, and
 *      the person stays on the machine they were driving rather than watching
 *      the page they were reading empty itself.
 */
export async function driveMachineTab(scope, row, { previous = null, transaction = null } = {}) {
  if (transaction && !transaction.current()) return { ok: false, cancelled: true }
  const bridge = machineTabsBridge(scope)
  if (!bridge) return { ok: false, sentence: MACHINE_TAB_NO_BRIDGE }
  if (!row || !named(row.relayPairId) || !named(row.devicePairId)) {
    return { ok: false, sentence: MACHINE_TAB_NOT_CHOSEN }
  }
  if (row.trouble) return { ok: false, sentence: row.trouble }

  let chosen = null
  try { chosen = await bridge.chooseMachine({ relayPairId: row.relayPairId, devicePairId: row.devicePairId, ...transaction?.prepare(row) }) } catch {
    return { ok: false, sentence: MACHINE_TAB_NOT_CHOSEN }
  }
  if (transaction && !transaction.current()) return { ok: false, cancelled: true }
  if (!chosen || chosen.ok !== true) return { ok: false, sentence: reasonOf(chosen, MACHINE_TAB_NOT_CHOSEN) }
  if (transaction && !transaction.committed()) return { ok: false, cancelled: true }

  const awake = await machineAnswers(bridge, row)
  if (transaction && !transaction.current()) return { ok: false, cancelled: true }
  if (awake.ok) return awake

  const back = await putBack(bridge, previous, transaction)
  if (back.cancelled || (transaction && !transaction.current())) return { ok: false, cancelled: true }
  if (back.failed) return { ok: false, sentence: `${awake.sentence} ${MACHINE_TAB_NOT_PUT_BACK}` }
  return { ok: false, sentence: `${awake.sentence} ${machineTabStaysOn(back.restored ? previous : null)}` }
}
