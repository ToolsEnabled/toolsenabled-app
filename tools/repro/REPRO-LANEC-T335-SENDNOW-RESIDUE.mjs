/* LANE C ITEM 1 -- "one Send now must not lock the next", the unbounded wait for
 * idle behind it, AND the same question asked of a SECOND agent.
 *
 * THE RESIDUE. After one Send now whose interrupt the host accepted, the
 * composer waits for THIS window's status to read idle before the engine send
 * goes out. When that completion never arrives (a provider that emits nothing
 * for an abandoned turn; a host whose own release wait timed out) the wait had
 * no bound: `stopping` stayed true, every stop door stayed locked, the durable
 * hold stayed on the row, and the NEXT Send now was refused with
 *   "A Send now is already waiting for this agent to stop."
 * until the row was unqueued by hand.
 *
 * WHY THERE IS A SECOND SCENARIO. src/session-outbox.js keeps its hold
 * bookkeeping at MODULE level -- `sendHolds` keyed by entry id, `checkedOut`,
 * `drainHolds`, `outstandingDeliveries` -- shared by every surface in the
 * renderer. State like that can be right for the FIRST agent and wrong for
 * every later one, and a one-agent gate cannot see the difference. Scenario TWO
 * therefore builds TWO agents and asserts against the SECOND, while the first
 * is still parked under a live named hold.
 *
 * This drives the REAL buildChat over the REAL src/session-outbox.js store
 * through the REAL Page 2 hold adapter (read out of src/views/computers.js the
 * way chat-queue-doors.test.mjs does), with an onStop that acknowledges the
 * interrupt and then never reports idle. It asserts what a person sees.
 *
 *   SCENARIO ONE -- one agent
 *   R1  within the release budget (ratified 150-250 ms; 1.5 s allowed here for
 *       timer lateness on a loaded box) the row is parked under a NAMED hold,
 *       with Retry send and Unqueue enabled, and the stop doors unlock
 *   R2  a second Send now is then TAKEN, not refused as "already waiting"
 *   R3  no refusal reached the glass, and the words are queued exactly once
 *
 *   SCENARIO TWO -- two agents, asserted on the SECOND
 *   R4  agent B's Send now is not refused while agent A is parked
 *   R5  agent B's press reaches B's OWN stop, and not A's
 *   R6  agent B's row parks under its own named hold, with its own two doors
 *   R7  A's hold and B's hold coexist: each queue holds its own words exactly
 *       once, neither agent's row lost its name, and no refusal reached either
 *       piece of glass
 *
 * RED at base 9413ef30 (cut2/app-assembly-20260917): waitForIdle() resolves only
 * on idle or teardown, so R1 never happens and R2 is refused.
 * GREEN at the lane tip: the budget expires into parkSendNow().
 *
 * Run:  node tools/repro/REPRO-LANEC-T335-SENDNOW-RESIDUE.mjs --app <path to an app worktree>
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const appArg = process.argv.indexOf('--app')
if (appArg < 0 || !process.argv[appArg + 1]) {
  console.error('REFUSED: --app <path to an app worktree> is required. This script pins no path of its own.')
  process.exit(2)
}
const ROOT = process.argv[appArg + 1]
const href = p => pathToFileURL(join(ROOT, ...p)).href
const { installDomStandIn } = await import(href(['tools', 'test', 'lib', 'dom-stand-in.mjs']))
installDomStandIn(globalThis)
const savedQueue = new Map()
globalThis.localStorage = {
  getItem: key => savedQueue.get(key) ?? null,
  setItem: (key, value) => savedQueue.set(key, String(value)),
  removeItem: key => savedQueue.delete(key),
}
const { buildChat } = await import(href(['src', 'components.js']))
const outbox = await import(href(['src', 'session-outbox.js']))
const { QUEUE_PANEL } = await import(href(['src', 'fleet-tree-copy.js']))
const { parseSlashCommand } = await import(href(['src', 'slash-commands.js']))

/* The Page 2 adapter itself, executed, so the hold each surface takes is the one
   the product takes. Missing means this tree has no durable Send now at all,
   which is a different (older) defect and is refused by name. */
const viewSource = readFileSync(join(ROOT, 'src', 'views', 'computers.js'), 'utf8')
const holdAdapter = viewSource.match(/hold: (request => \{[\s\S]*?\n        \}),/)
if (!holdAdapter) {
  console.error('REFUSED: src/views/computers.js carries no `hold:` queue adapter at this ref; nothing here can be measured.')
  process.exit(2)
}
const makeHold = new Function('liveSessionId', 'notePersonSpokeTo', 'treeStore', 'node', 'parseSlashCommand', 'outboxHoldForSend',
  `return (${holdAdapter[1]})`)

const failures = []
const tick = ms => new Promise(resolve => setTimeout(resolve, ms))

/* One mounted agent: its own session id, its own status, its own stop, its own
   glass. Everything below the surface -- the store and its module-level hold
   bookkeeping -- is deliberately SHARED, because that sharing is what scenario
   two exists to test. */
function buildSurface(sessionId) {
  outbox.clearSession(sessionId)
  const listeners = new Set()
  const state = { busy: true, stopped: 0, attempted: [] }
  const root = buildChat({
    title: sessionId,
    seed: 0,
    status: {
      busy: () => state.busy,
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    },
    queue: {
      list: () => outbox.list(sessionId).map(entry => ({
        id: entry.id, text: entry.text,
        ...(entry.deliveryUnconfirmed ? { deliveryUnconfirmed: true } : {}),
        ...(typeof entry.heldReason === 'string' && entry.heldReason ? { heldReason: entry.heldReason } : {}),
      })),
      add: text => outbox.enqueue(sessionId, text),
      cancel: id => outbox.cancel(sessionId, id),
      replace: (id, text) => outbox.replace(sessionId, id, text),
      hold: makeHold(() => sessionId, () => {}, null, { sessionId }, parseSlashCommand, outbox.holdForSend),
      sendNow: id => (outbox.promoteFront(sessionId, id)
        ? { ok: true, sentence: QUEUE_PANEL.movedFront }
        : { ok: false, sentence: QUEUE_PANEL.moveGone }),
    },
    chips: {},
    onSend: (text, { reply, accepted }) => {
      if (parseSlashCommand(text)) return
      state.attempted.push(text)
      accepted?.()
      reply(`answered: ${text}`)
    },
    /* The host took the interrupt. The completion never comes. */
    onStop: () => { state.stopped += 1; return Promise.resolve({ ok: true, settled: false, sentence: 'Interrupted.' }) },
  })
  const input = root.querySelector('.chat-input input')
  const surface = {
    sessionId, root, state,
    sendButton: root.querySelector('.chat-send'),
    rows: () => root.querySelectorAll('.chat-queue-row'),
    heldRow: () => root.querySelectorAll('.chat-queue-row').find(row => row.querySelector('.chat-queue-state')?.dataset?.heldReason),
    notes: () => root.querySelectorAll('.msg').filter(node => /\bnote\b/.test(node.className)).map(node => node.textContent),
    words: () => outbox.list(sessionId).map(entry => entry.text),
    async sendNow(text) {
      input.value = text
      input.dispatch('input')
      await tick(30)
      input.dispatch('keydown', { key: 'Enter', shiftKey: true })
      await tick(0)
    },
    async waitForHold(budgetMs = 1500) {
      const started = performance.now()
      while (performance.now() - started < budgetMs) {
        if (surface.heldRow()) return performance.now() - started
        await tick(10)
      }
      return null
    },
    doorsOn(row) {
      return row ? row.querySelectorAll('button').map(button => `${button.textContent}${button.disabled ? '(disabled)' : ''}`) : []
    },
  }
  return surface
}

// ---------------------------------------------------------------- scenario one
const one = buildSurface('laneC-t335-residue')
await one.sendNow('first now')
if (one.state.stopped !== 1) failures.push('setup: the first Send now did not reach the stop at all')

const parkedAfterMs = await one.waitForHold()
const parked = one.heldRow()
const doors = one.doorsOn(parked)
if (!parked) failures.push('R1 no NAMED hold appeared within 1.5 s: the wait for idle is unbounded (silent stall)')
else {
  if (!doors.includes(QUEUE_PANEL.retryUnconfirmed)) failures.push(`R1 the parked row has no enabled Retry send (doors: ${doors.join(', ')})`)
  if (!doors.some(label => /^Unqueue$/.test(label))) failures.push(`R1 the parked row has no enabled Unqueue (doors: ${doors.join(', ')})`)
}
if (one.sendButton.disabled !== false) failures.push('R1 the stop doors are still locked after the budget (send button disabled)')

await one.sendNow('second now')
const refusedOne = one.notes().filter(text => /already waiting/i.test(text))
if (refusedOne.length) failures.push(`R2 the second Send now was refused: ${JSON.stringify(refusedOne[0])}`)
if (one.state.stopped !== 2) failures.push(`R2 the second Send now did not reach the stop (stops seen: ${one.state.stopped})`)
const wordsOne = one.words()
if (wordsOne.filter(t => t === 'first now').length !== 1 || wordsOne.filter(t => t === 'second now').length !== 1) {
  failures.push(`R3 the queue does not hold each message exactly once: ${JSON.stringify(wordsOne)}`)
}
if (one.state.attempted.length) failures.push(`R3 something was sent into a turn this window never saw end: ${JSON.stringify(one.state.attempted)}`)
const glassOne = one.notes().filter(text => /refused|could not|already waiting/i.test(text))
if (glassOne.length) failures.push(`R3 a refusal reached the glass: ${JSON.stringify(glassOne)}`)

// ---------------------------------------------------------------- scenario two
/* AGENT A IS LEFT PARKED ON PURPOSE. Its hold is live in the module-level
   `sendHolds` for the whole of what follows, which is the condition a
   first-instance-only fix survives and a correct one does not notice. */
const agentA = buildSurface('laneC-t335-two-A')
const agentB = buildSurface('laneC-t335-two-B')
/* B PRESSES WHILE A'S HOLD IS STILL LIVE. Not after A has parked: parking
   RELEASES A's reservation (restore() deletes it from `sendHolds`), so a B that
   waits for A to park never meets the shared state at all and the check would
   pass vacuously. B presses inside A's release budget, which is the only window
   in which `sendHolds` actually holds two agents' business at once. */
await agentA.sendNow('A waits here')
const aHoldLive = outbox.list('laneC-t335-two-A').some(entry => !entry.heldReason)
if (!aHoldLive) failures.push('setup(two): agent A parked before B could press, so the shared-state window was never entered')
await agentB.sendNow('B must not be blocked by A')

const aParkedMs = await agentA.waitForHold()
if (!aParkedMs) failures.push('setup(two): agent A never parked at all')
const aHeldBefore = agentA.heldRow()?.querySelector('.chat-queue-state')?.dataset?.heldReason || null

const refusedB = agentB.notes().filter(text => /already waiting/i.test(text))
if (refusedB.length) failures.push(`R4 agent B's Send now was refused while agent A was parked: ${JSON.stringify(refusedB[0])}`)
if (agentB.state.stopped !== 1) failures.push(`R5 agent B's press did not reach B's own stop (B stops: ${agentB.state.stopped})`)
if (agentA.state.stopped !== 1) failures.push(`R5 agent B's press reached AGENT A's stop (A stops: ${agentA.state.stopped}, expected 1)`)

const bParkedMs = await agentB.waitForHold()
const bParked = agentB.heldRow()
const bDoors = agentB.doorsOn(bParked)
if (!bParked) failures.push('R6 agent B never parked under a named hold, though agent A did: the hold state is first-instance-only')
else {
  if (!bDoors.includes(QUEUE_PANEL.retryUnconfirmed)) failures.push(`R6 agent B's parked row has no enabled Retry send (doors: ${bDoors.join(', ')})`)
  if (!bDoors.some(label => /^Unqueue$/.test(label))) failures.push(`R6 agent B's parked row has no enabled Unqueue (doors: ${bDoors.join(', ')})`)
}
if (agentB.sendButton.disabled !== false) failures.push('R6 agent B\'s stop doors are still locked after its budget')

const aHeldAfter = agentA.heldRow()?.querySelector('.chat-queue-state')?.dataset?.heldReason || null
if (aHeldBefore === null) failures.push('R7 agent A lost its named hold entirely once agent B took one')
if (aHeldBefore && aHeldAfter !== aHeldBefore) {
  failures.push(`R7 agent B's hold changed agent A's row: ${aHeldBefore} -> ${aHeldAfter}`)
}
const wordsA = agentA.words(); const wordsB = agentB.words()
if (wordsA.filter(t => t === 'A waits here').length !== 1 || wordsA.some(t => /^B /.test(t))) {
  failures.push(`R7 agent A's queue is wrong: ${JSON.stringify(wordsA)}`)
}
if (wordsB.filter(t => t === 'B must not be blocked by A').length !== 1 || wordsB.some(t => /^A /.test(t))) {
  failures.push(`R7 agent B's queue is wrong: ${JSON.stringify(wordsB)}`)
}
if (agentA.state.attempted.length || agentB.state.attempted.length) {
  failures.push(`R7 something was sent into a turn no window saw end: A=${JSON.stringify(agentA.state.attempted)} B=${JSON.stringify(agentB.state.attempted)}`)
}
const glassTwo = [...agentA.notes(), ...agentB.notes()].filter(text => /refused|could not|already waiting/i.test(text))
if (glassTwo.length) failures.push(`R7 a refusal reached the glass: ${JSON.stringify(glassTwo)}`)

// ------------------------------------------------------------------- the words
let head = 'unknown'
try { head = readFileSync(join(ROOT, '.git'), 'utf8').trim().slice(0, 80) } catch { /* a clone's .git is a directory */ }
console.log(`app tree     : ${ROOT}`)
console.log(`git head file: ${head}`)
console.log('-- scenario ONE, one agent --')
console.log(`R1 named hold within budget : ${parked ? `YES after ${parkedAfterMs.toFixed(0)} ms (${parked.querySelector('.chat-queue-state').dataset.heldReason})` : 'NO'}`)
console.log(`R1 doors on the parked row  : ${doors.length ? doors.join(', ') : 'n/a'}`)
console.log(`R1 stop doors unlocked      : ${one.sendButton.disabled === false ? 'YES' : 'NO'}`)
console.log(`R2 second Send now taken    : ${refusedOne.length === 0 && one.state.stopped === 2 ? 'YES' : 'NO'}`)
console.log(`R3 queue                    : ${JSON.stringify(wordsOne)}`)
console.log('-- scenario TWO, agent B while agent A is parked --')
console.log(`R4 B not refused            : ${refusedB.length === 0 ? 'YES' : 'NO'}`)
console.log(`R5 stops  A / B             : ${agentA.state.stopped} / ${agentB.state.stopped}   (expect 1 / 1)`)
console.log(`R6 B named hold             : ${bParked ? `YES after ${bParkedMs.toFixed(0)} ms (${bParked.querySelector('.chat-queue-state').dataset.heldReason})` : 'NO'}`)
console.log(`R6 doors on B's parked row  : ${bDoors.length ? bDoors.join(', ') : 'n/a'}`)
console.log(`R7 A's hold after B parked  : ${aHeldBefore} -> ${aHeldAfter}`)
console.log(`R7 queues A / B             : ${JSON.stringify(wordsA)} / ${JSON.stringify(wordsB)}`)

one.root.dispose(); agentA.root.dispose(); agentB.root.dispose()
if (failures.length) {
  console.log('\nRED')
  for (const line of failures) console.log(`  - ${line}`)
  process.exit(1)
}
console.log('\nGREEN')
process.exit(0)
