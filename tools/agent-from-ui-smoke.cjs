'use strict'

/* End-to-end proof that a person can start an agent FROM THE INTERFACE.
 *
 * This boots the REAL shell/main.cjs -- the actual application, its actual
 * window, its actual preload -- and then drives the real renderer the way a
 * person would reach it: through window.mcAgent, the contextBridge surface.
 * Nothing here re-implements or re-registers any part of the app.
 *
 * Verified by exit code. Any failed step exits non-zero.
 */

const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const { reapDescendants } = require('./process-tree.cjs')

const APP_ROOT = process.env.MC_APP_ROOT || path.resolve(__dirname, '..')
const TIMEOUT_MS = 180_000

const steps = []
function step(name, ok, detail) {
  steps.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  :: ' + detail : ''}`)
}

function fatal(message) {
  console.error('E2E FATAL: ' + message)
  finish(20)
}

/* Reap our own descendants BEFORE exiting, from here, while this process is
   still alive.
 *
 * This must happen here and cannot be done by the runner. Booting the app
 * starts a crashpad handler and the shell spawns the capability bridge, and
 * both outlive this process. The runner's only handle is THIS pid, and by the
 * time it acts this pid is already gone -- so `taskkill /PID <this> /T /F`
 * fails outright with "process not found" and reaps nothing. Measured
 * directly: /T walks live parent->child links, and a dead middle ends the
 * walk. Credit to the tier-screen lane for catching that my first check used
 * a LIVE middle and therefore could not tell the two cases apart.
 *
 * Here the links are still intact, so the walk finds everything.
 *
 * Why it is worth doing at all: a survivor holds the app-wide single-instance
 * lock, and a peer's release harness read the installed app quitting on a
 * lock this smoke was holding as a CRASH. It measured a launch regression
 * that did not exist and nearly filed it against another lane's commits.
 */
let finishing = false
function finish(code) {
  if (finishing) return
  finishing = true
  const reaped = reapDescendants(process.pid)
  if (reaped > 0) console.log(`[smoke] reaped ${reaped} descendant process(es) before exit`)
  app.exit(code)
}

// Boot the real application.
require(path.join(APP_ROOT, 'shell', 'main.cjs'))

async function windowReady() {
  const deadline = Date.now() + 60_000
  for (;;) {
    const windows = BrowserWindow.getAllWindows()
    const win = windows.find(w => !w.isDestroyed())
    if (win) {
      if (win.webContents.isLoading()) {
        await new Promise(resolve => win.webContents.once('did-finish-load', resolve))
      }
      return win
    }
    if (Date.now() > deadline) throw new Error('no BrowserWindow appeared within 60s')
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

async function run() {
  const win = await windowReady()
  const js = (code) => win.webContents.executeJavaScript(code, true)

  step('the real app window loaded', true, await js('document.title'))

  /* 1. The bridge exists in the renderer at all, and is still BOUNDED.
   *
   * This was one frozen list compared with `===`, and it had gone stale: the
   * preload has exposed `confinement` and `history` since the tier screen and
   * the home screen's local-history panel landed, so the assertion was RED on a
   * healthy product and stayed red -- a guard that cries wolf is a guard nobody
   * reads. Widening it to "at least these" would have been the other error,
   * because the property this step is named for is that the surface is BOUNDED:
   * a method appearing on window.mcAgent is a new way into the main process
   * from the page, and it must be a decision somebody made rather than
   * something that arrived by silence. That is the absence-as-consent shape
   * this codebase keeps producing.
   *
   * So both directions are checked and both are named in the failure: REQUIRED
   * is what this smoke actually drives and cannot lose; RECOGNISED is the whole
   * reviewed vocabulary, and anything outside it fails until someone adds it
   * here deliberately. */
  const REQUIRED = ['availability', 'close', 'interrupt', 'onEvent', 'send', 'start']
  /* Kept as the reviewed public surface, not inferred from the preload at
     runtime. Inferring it would let an accidental new IPC door approve itself.

     This list had stopped at the first eight methods while the real preload
     had grown to twenty-five. The smoke therefore failed before it exercised
     start(), even though every added method was already an intentional,
     separately gated product surface. A launch proof which cannot reach its
     launch is not a proof. Keep this exact list in step with
     shell/fleet-profile-preload.cjs and let either an addition or removal fail
     loudly until it is reviewed here. */
  const RECOGNISED = [
    /* Reviewed standalone-to-tree placement: assigns an already-owned
       session using bounded names and tree identity; no path or new process.
       The command surface checks session ownership before host adoption. */
    'adoptTreeAddress',
    'answerApproval',
    /* The Ledger page's write verbs for task and ask records (ledger kinds,
       2026-09-07). Reviewed: person-only (window or signed-in relay), a
       bounded id in, {ok, id, status} out, no path -- the same fence as
       requestEdit/requestRemove/requestDecide below. */
    'answerAsk',
    'availability',
    'close',
    'completeTask',
    'confinement',
    /* Opted-in saved continuations of this window's ledger work. Reviewed:
       window-only principal, bounded action/key/revision/ids in; discard and
       attach act only on an owned session, and resume re-enters the ordinary
       agent:start with its spawn record and gates. The read returns the saved
       start descriptor, which can include its working directory. */
    'continuations',
    'declineAsk',
    /* The standing goal -- read, set and clear on one command (T61). Reviewed:
       a write, because a goal makes the session start turns of its own and
       spend on them, so it carries agent:send's fence exactly -- trusted
       sender, window principal, ownedAgentSession() on a bounded sessionId.
       agentPayload() admits only sessionId/operation/objective; an unknown
       operation refuses by name rather than falling back to the read. No path,
       no new process, and nothing outside the session it names. */
    'goal',
    'history',
    'interrupt',
    'ledger',
    /* Person-only category reset: preview returns the current count/revision
       and confirmation token; confirm rejects a changed category. No caller
       path, agent principal, or purchase authorization is accepted. */
    'ledgerResetConfirm',
    'ledgerResetPreview',
    'localMessages',
    'models',
    'onEvent',
    /* Attaches only bytes from this window's explicit paste gesture. Reviewed:
       window-only principal, owned session, bounded MIME/decoded image size,
       app-issued path, and no ambient clipboard read or agent execution. */
    'pasteAttachment',
    'pickAttachment',
    'pickMention',
    'profileCreate',
    'profileRemove',
    'profiles',
    'removeAsk',
    'removeTask',
    'request',
    'requestDecide',
    'requestEdit',
    'requestRemove',
    'requests',
    /* The person's resolution of one standing request (R_LEDGER kinds
       follow-on, 2026-09-07). Reviewed: person-only, a bounded id/status/
       reason in, {ok, id, status} out, no path -- the same fence as
       requestDecide above. */
    'resolveStandingRequest',
    'rewind',
    'send',
    /* Which account each running agent is on. Reviewed: a read that starts
       nothing, moves nothing, and carries names and codes -- no path, and no
       arrow beside it that could act on what it reports. */
    'sessionAccounts',
    /* Window-only read of an owned session's busy/closing state and bounded
       provider outcome. Starts no process and reads no credential bytes. */
    'sessionActivity',
    'setEffort',
    /* Reviewed direct tree links: listing reads local opaque node ids; setting
       accepts only bounded from/to ids and a boolean. The command surface
       requires this native window for the write and starts no provider. */
    'setTreeLink',
    'start',
    'startableTiers',
    'tools',
    'treeLinks',
    /* Re-addresses one already-running Page 2 circle after a saved tree move.
       Reviewed: bounded ids/names only, no path and no new process. */
    'updateTreeAddress',
    'usage',
    /* Reads the retained status and signed start/end records for this window's
       bounded work. Reviewed: owned session and principal, no mutation, no
       process launch, and no remote facade entry point. */
    'workStatus',
  ]
  const surface = await js('JSON.stringify(Object.keys(window.mcAgent || {}).sort())')
  const keys = JSON.parse(surface)
  const missingRequired = REQUIRED.filter(key => !keys.includes(key))
  const missingReviewed = RECOGNISED.filter(key => !keys.includes(key))
  const unreviewed = keys.filter(key => !RECOGNISED.includes(key))
  step(
    'window.mcAgent exposes exactly the reviewed bounded surface',
    missingRequired.length === 0 && missingReviewed.length === 0 && unreviewed.length === 0,
    `missingRequired=${JSON.stringify(missingRequired)} missingReviewed=${JSON.stringify(missingReviewed)} unreviewed=${JSON.stringify(unreviewed)} actual=${surface}`,
  )

  // 2. Availability answers, and answers without a path.
  const availability = await js('window.mcAgent.availability().then(JSON.stringify)')
  const parsed = JSON.parse(availability)
  step('availability round-trips renderer -> main', typeof parsed === 'object' && parsed !== null, availability)
  step('availability leaks no path', !/[\\/]/.test(JSON.stringify(Object.values(parsed))), availability)
  if (parsed.ok !== true) {
    step('an engine is configured for this run', false, 'code=' + parsed.code)
    return
  }
  step('an engine is configured for this run', true, parsed.code)

  // 3. Start a real session, send a turn, and collect streamed output --
  //    entirely from inside the page.
  const result = await js(`(async () => {
    const id = crypto.randomUUID()
    let text = ''
    let done = null
    let sessionOpen = false
    const finished = new Promise(resolve => { done = resolve })
    const off = window.mcAgent.onEvent(packet => {
      if (!packet || packet.sessionId !== id || !packet.event) return
      const e = packet.event
      if (e.type === 'assistant_text_delta' && typeof e.text === 'string') text += e.text
      if (e.type === 'turn_completed') done(e.status || 'completed')
    })
    const timer = setTimeout(() => done('timeout'), 150000)
    try {
      const started = await window.mcAgent.start({ sessionId: id })
      sessionOpen = true
      await window.mcAgent.send({ sessionId: id, text: 'Reply with exactly the word: PONG' })
      const status = await finished
      const stopped = await window.mcAgent.close({ sessionId: id })
      sessionOpen = stopped.closed !== true
      return JSON.stringify({
        threadId: typeof started.threadId === 'string' && started.threadId.length > 0,
        recordSequence: started.record && started.record.sequence,
        recordHash: started.record && started.record.eventHash,
        status,
        reply: text.trim(),
        closed: stopped.closed === true,
      })
    } finally {
      clearTimeout(timer)
      off()
      if (sessionOpen) await window.mcAgent.close({ sessionId: id })
    }
  })()`)

  const session = JSON.parse(result)
  step('start() opened a real session from the page', session.threadId === true, 'threadId present')
  step(
    'the spawn was recorded before it ran',
    Number.isSafeInteger(session.recordSequence) && session.recordSequence > 0
      && /^[a-f0-9]{64}$/.test(String(session.recordHash || '')),
    `sequence=${session.recordSequence} hash=${String(session.recordHash).slice(0, 12)}`,
  )
  step('the turn completed', session.status === 'completed', 'status=' + session.status)
  step('output streamed back into the page', session.reply === 'PONG', 'reply=' + JSON.stringify(session.reply))
  step('close() stopped the session from the page', session.closed === true, 'closed=' + session.closed)

  /* Independent verification, from outside the code under test: rebuild a
     recorder over the same directory and re-check every hash, link, and
     signature. A chain nothing ever verifies is decoration. */
  const { app, safeStorage } = require('electron')
  const { createSpawnRecorder } = require(path.join(APP_ROOT, 'shell', 'spawn-record.cjs'))
  const verification = createSpawnRecorder({
    safeStorage,
    directory: app.getPath('userData'),
  }).verify()
  step(
    'the recorded chain verifies end to end',
    verification.ok === true && verification.count > 0,
    `count=${verification.count}${verification.ok ? '' : ' code=' + verification.code}`,
  )
}

app.whenReady().then(async () => {
  const guard = setTimeout(() => fatal('exceeded ' + TIMEOUT_MS + 'ms'), TIMEOUT_MS)
  try {
    await run()
    clearTimeout(guard)
    const failed = steps.filter(s => !s.ok)
    console.log(`\n${steps.length - failed.length}/${steps.length} steps passed`)
    /* Every exit path reaps. A failing run leaves the same survivors holding
       the same lock as a passing one. */
    finish(failed.length === 0 ? 0 : 1)
  } catch (error) {
    clearTimeout(guard)
    console.error('E2E ERROR:', error && error.stack ? error.stack : error)
    finish(21)
  }
})
