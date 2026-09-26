/* c4 second review, real window (j), pre-existing on candidate 3 and on c4:
 * with "Delete agent nodes when the app exits" on, the quit did not finish.
 * Send a first message on a New agent tab and close the window 0.3 s later.
 * The window's own close check passed (nothing was saving yet), the last window
 * closed, window-all-closed called app.quit(), and by then the message's save
 * had started: the quit gate refused and showed "Conversation has not been
 * saved" with no window behind it. The save finished a moment later, but nothing
 * asked to quit again; "Retry saving" could not quit (it required
 * appShutdown.started), "Keep ToolsEnabled open" left a process with no window,
 * and delete-on-exit never ran.
 *
 * main.cjs's own storage checks, notice, quit gate and before-quit handler run
 * from source over stand-ins for the stores and Electron.
 *
 * c5 (soak of candidate 4, 16 hangs; B35 remainder): the same with the window
 * still OPEN. SIGTERM or SIGINT from the system (logout, shutdown, `kill`) and
 * an update's restart call app.quit() without closing the window first. A
 * first message's save still running 0.3-0.8 s after its send refused the
 * quit and showed the notice; "Retry saving" could not quit either, and the
 * app sat on the notice until the system killed it. The guard that pinned
 * that ("with a window still open ... does not quit by itself") is rewritten
 * below. Closing the window with its X in the same moment showed "Free disk
 * space" with nothing wrong with the disk.
 *
 *   node --test --import=./tools/test/lib/isolate-native-state-root.mjs tools/test/c4r2-quit-after-last-window-while-saving.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { createAppQuitGate } = require('../../shell/app-shutdown.cjs')
const main = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

/* A window as Electron has it: close() emits 'close' (the handler may keep it
   open with preventDefault); once it is gone and none is left, window-all-closed
   quits the app. */
function electronWindow(f, { quitWhenLast = true } = {}) {
  let destroyed = false
  const window = {
    closeHandler: null,
    isDestroyed: () => destroyed,
    close() {
      if (destroyed) return
      const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
      window.closeHandler?.(event)
      if (event.defaultPrevented) { f.calls.push('close-kept'); return }
      destroyed = true
      f.calls.push('window-closed')
      if (quitWhenLast && f.windows.every(other => other.isDestroyed())) f.context.app.quit()
    },
  }
  f.windows.push(window)
  return window
}
/* main.cjs's own handler for the window's 'close' event (createWindow), over the same stand-ins. */
function windowCloseHandler(f, window) {
  const marker = "win.on('close', (event) => {\n    if (!transcriptsCanQuit())"
  const start = main.indexOf(marker)
  const end = main.indexOf('\n  })\n', start)
  assert.ok(start >= 0 && end > start, 'main.cjs has the window close handler')
  Object.assign(f.context, { window, closeRequested: false, closeWarningPending: false, quitWithoutWindowClose: false,
    runningAgentCount: () => 0, CLOSE_WARNING_KEY: 'mc.close-warning.v1' })
  window.closeHandler = vm.runInContext('(' + main.slice(start + "win.on('close', ".length, end + 4) + ')', f.context)
}

function quitFixture({ windows = [], date = Date } = {}) {
  const first = main.indexOf('function transcriptsCanQuit() {')
  const last = main.indexOf('\nwireSingleInstance({', first)
  assert.ok(first >= 0 && last > first)
  const state = { saving: true, diskFull: false }
  const calls = []
  const prompts = []
  let beforeQuit = null
  const appShutdown = {
    started: false,
    beforeQuit(event) {
      event.preventDefault()
      if (!this.started) calls.push('shutdown-begins') // closes agents, then delete-on-exit, then exits
      this.started = true
    },
  }
  windows = [...windows]
  const context = {
    setTimeout, clearTimeout, Date: date,
    createAppQuitGate, appShutdown,
    nodeTranscripts: {
      getStorageStatus: () => (state.diskFull
        ? { durable: false, pendingWrites: 0, storageError: { code: 'MC_TRANSCRIPT_DISK_FULL', message: 'The disk is full.' } }
        : { durable: true, pendingWrites: 0 }),
      retry: async () => (state.diskFull ? { durable: false } : { ok: true, durable: true }),
    },
    transcriptCapture: {
      getStorageStatus: () => ({ durable: true, pendingWrites: 0 }), hasPendingWrites: () => false,
      retry: async () => ({ ok: true, durable: true }),
    },
    // The message's admission: held from its reservation until its words are saved.
    agentHost: { hasPendingTranscriptAdmissions: () => state.saving },
    rendererPrefs: { snapshot: () => ({ fleetPending: false, fleetWriteError: null }), flushFleetDocuments: async () => ({ ok: true }) },
    refreshStorageRefusalNotice() {},
    BrowserWindow: { getAllWindows: () => windows },
    dialog: { showMessageBox(options) { const answer = Promise.withResolvers(); prompts.push({ options, answer }); return answer.promise } },
    exitRecord: { writeExitRecord() {} },
    app: {
      on(name, callback) { assert.equal(name, 'before-quit'); beforeQuit = callback },
      quit() { calls.push('app.quit'); const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }; beforeQuit(event) },
    },
  }
  vm.createContext(context)
  vm.runInContext(main.slice(first, last), context)
  return { state, calls, prompts, appShutdown, context, windows }
}
const waitFor = async (done, ms = 2000) => { for (let waited = 0; waited < ms && !done(); waited += 50) await pause(50) }

test('c4r2 (j): the last window closed while a message was being saved: the quit finishes once the save does, with no notice', async () => {
  const f = quitFixture()
  // window-all-closed: the person closed the last window 0.3 s after sending.
  f.context.app.quit()
  assert.equal(f.appShutdown.started, false, 'nothing may be sealed while the message is still being saved')
  await pause(50)
  f.state.saving = false // the provider accepted the message and its words were saved
  for (let waited = 0; waited < 2000 && !f.appShutdown.started; waited += 50) await pause(50)
  assert.equal(f.appShutdown.started, true, 'the quit was dropped: ToolsEnabled kept running with no window, and delete-on-exit never ran')
  assert.equal(f.prompts.length, 0, `a "${f.prompts[0]?.options?.title}" notice was shown with no window behind it`)
})

test('c4r2 (j): with no window left, "Retry saving" after a storage failure quits once saved', async () => {
  const f = quitFixture()
  f.state.saving = false
  f.state.diskFull = true
  f.context.app.quit()
  await pause(20)
  assert.equal(f.prompts.length, 1, 'a real storage failure still shows its notice')
  assert.equal(f.appShutdown.started, false)
  f.state.diskFull = false // the person freed disk space
  f.prompts[0].answer.resolve({ response: 0 })
  for (let waited = 0; waited < 2000 && !f.appShutdown.started; waited += 50) await pause(50)
  assert.equal(f.appShutdown.started, true, '"Retry saving" saved everything and still did not quit')
})

test('c5 B35: the system quits with the window still open while a first message is being saved: the quit finishes once the save does, with no notice', async () => {
  const f = quitFixture()
  const window = electronWindow(f)
  f.context.app.quit() // SIGTERM from a logout or `kill`, or an update's restart
  assert.equal(f.appShutdown.started, false, 'nothing may be sealed while the message is still being saved')
  assert.equal(window.isDestroyed(), false, 'the window stays until the save is done')
  await pause(50)
  f.state.saving = false // the provider accepted the message and its words were saved
  await waitFor(() => f.appShutdown.started)
  assert.equal(f.prompts.length, 0, `THE DEFECT: a "${f.prompts[0]?.options?.title}" notice was shown for a save that was only running`)
  assert.equal(f.appShutdown.started, true, `THE DEFECT: the quit was dropped and the app waited for the system to kill it (calls: ${f.calls.join(', ')})`)
  assert.equal(window.isDestroyed(), true, 'the quit closed the window')
})

test('c5 B35: with the window open, a real storage failure still shows its notice; "Retry saving" once it is fixed finishes the quit', async () => {
  const f = quitFixture()
  electronWindow(f)
  f.state.saving = false
  f.state.diskFull = true
  f.context.app.quit()
  await waitFor(() => f.prompts.length > 0, 600)
  assert.equal(f.prompts.length, 1, 'a real storage failure still shows its notice')
  assert.match(f.prompts[0].options.detail, /Free disk space/, 'a real disk problem still says what to do about it')
  assert.equal(f.appShutdown.started, false)
  f.state.diskFull = false // the person freed disk space
  f.prompts[0].answer.resolve({ response: 0 })
  await waitFor(() => f.appShutdown.started)
  assert.equal(f.appShutdown.started, true, 'THE DEFECT: "Retry saving" saved everything and still did not quit')
})

test('c5 B35: a window opened after the refused quit (the person came back) cancels the quit', async () => {
  const f = quitFixture()
  electronWindow(f)
  f.context.app.quit()
  await pause(20)
  electronWindow(f, { quitWhenLast: false }) // a second window: the person is using the app again
  f.state.saving = false
  await pause(600)
  assert.equal(f.appShutdown.started, false, 'the app quit behind a window the person had just opened')
  assert.equal(f.prompts.length, 0)
})

test('c5 B35: the window\'s X while a first message is being saved shows no disk notice, and the window closes once saved', async () => {
  const f = quitFixture()
  const window = electronWindow(f, { quitWhenLast: false })
  windowCloseHandler(f, window)
  window.close() // the person's X, 0.3 s after sending
  assert.equal(window.isDestroyed(), false, 'the window closed while its message was still being saved')
  await pause(50)
  assert.equal(f.prompts.length, 0, `THE DEFECT: "${f.prompts[0]?.options?.title}" with "${f.prompts[0]?.options?.detail}" for a save that was only running`)
  f.state.saving = false
  await waitFor(() => window.isDestroyed())
  assert.equal(f.prompts.length, 0)
  assert.equal(window.isDestroyed(), true, 'the close the person asked for never happened')
})

test('c5 B35: the window\'s X during a real storage failure still shows the notice and keeps the window', async () => {
  const f = quitFixture()
  const window = electronWindow(f, { quitWhenLast: false })
  windowCloseHandler(f, window)
  f.state.saving = false
  f.state.diskFull = true
  window.close()
  await waitFor(() => f.prompts.length > 0, 600)
  assert.equal(f.prompts.length, 1)
  assert.match(f.prompts[0].options.detail, /Free disk space/)
  assert.equal(window.isDestroyed(), false)
})

test('c5 B35: a save still running after the minute\'s wait says it is slow, not to free disk space', async () => {
  let offset = 0
  const clock = class extends Date { static now() { return Date.now() + offset } }
  const f = quitFixture({ date: clock })
  electronWindow(f)
  f.context.app.quit() // the system's quit, with the first message still being saved
  await pause(50)
  offset = 61_000 // a minute later the save is still running
  await waitFor(() => f.prompts.length > 0, 1000)
  assert.equal(f.prompts.length, 1, 'after the wait the notice is shown')
  assert.doesNotMatch(f.prompts[0].options.detail, /Free disk space/, 'a slow save was given disk advice')
  assert.match(f.prompts[0].options.detail, /taking longer than usual/)
})

/* c5 review: A QUIT ASKED FOR WHILE THE NOTICE IS ALREADY UP WAS DROPPED. The
   notice from the window's X (a real storage failure) is on screen; the system
   then quits (logout, shutdown, `kill`). The gate refused, and the refusal's
   quit request returned early behind the pending notice, whose own
   quitRequested was false with a window open, so "Retry saving" did not quit. */
test('c5 B35: the system quits while the X-close storage notice is up; "Retry saving" once fixed finishes the quit', async () => {
  const f = quitFixture()
  const window = electronWindow(f, { quitWhenLast: true })
  windowCloseHandler(f, window)
  f.state.saving = false
  f.state.diskFull = true
  window.close() // the person's X: a real storage failure, so the notice shows
  await waitFor(() => f.prompts.length > 0, 600)
  assert.equal(f.prompts.length, 1)
  f.context.app.quit() // then logout / shutdown / kill: SIGTERM -> app.quit()
  await pause(50)
  assert.equal(f.prompts.length, 1, 'one notice at a time')
  f.state.diskFull = false // the person freed disk space
  f.prompts[0].answer.resolve({ response: 0 }) // Retry saving
  await waitFor(() => f.appShutdown.started, 1500)
  assert.equal(f.appShutdown.started, true, `THE DEFECT: the system's quit was dropped behind the notice (calls: ${f.calls.join(', ')})`)
})

test('c5 B35: the system quits while the X-close notice is up; "Keep ToolsEnabled open" then the save finishing still quits', async () => {
  const f = quitFixture()
  const window = electronWindow(f, { quitWhenLast: true })
  windowCloseHandler(f, window)
  f.state.saving = false
  f.state.diskFull = true
  window.close()
  await waitFor(() => f.prompts.length > 0, 600)
  f.context.app.quit() // the system's quit arrives behind the notice
  await pause(50)
  f.state.diskFull = false
  f.prompts[0].answer.resolve({ response: 1 }) // Keep ToolsEnabled open: the notice goes, the system's quit stands
  await waitFor(() => f.appShutdown.started, 1500)
  assert.equal(f.appShutdown.started, true, `the system's quit was dropped (calls: ${f.calls.join(', ')})`)
})

/* c5 real-window run (pre-existing; the build without the B35 fix lost it the
   same way): A FIRST MESSAGE QUIT ON DURING ITS START WAS LOST WITH NO TRACE.
   A New agent tab's first message starts its session first and is sent only
   once the session is open. For the 0.2-0.6 s the start takes nothing is
   saving yet, so the quit went through, closed the starting session, and the
   message went with it: the tab came back empty and nothing was saved (17 of
   37 quits). main.cjs's own start and send handlers run here over the stand-ins. */
function agentChannels(f, { startMs = 120, sendMs = 60 } = {}) {
  const handlers = new Map()
  const at = name => {
    const marker = `ipcMain.handle('${name}', `
    const start = main.indexOf(marker)
    const end = main.indexOf('\n})\n', start)
    assert.ok(start >= 0 && end > start, `main.cjs handles ${name}`)
    return main.slice(start, end + 3)
  }
  const sender = { destroyed: [], once(name, callback) { if (name === 'destroyed') this.destroyed.push(callback) }, removeListener(name, callback) { this.destroyed = this.destroyed.filter(other => other !== callback) } }
  // The real command surface's run, as main.cjs wraps it (withFirstMessageHold).
  const surface = f.context.withFirstMessageHold({
    async run(command, value) {
      f.calls.push(command)
      await pause(command === 'agent:start' ? startMs : sendMs)
      if (command === 'agent:start') return value.refuse ? { ok: false, code: 'AGENT_REFUSED' } : { ok: true, sessionId: value.sessionId }
      f.state.saving = false // the message's admission ended with its words saved
      return { ok: true, turnId: 'turn-1' }
    },
  })
  Object.assign(f.context, {
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    assertTrustedAgentSender() {}, windowPrincipal: event => ({ kind: 'window', owner: event.sender }),
    rendererSafeAgentError: error => error,
    runEndedRecoveryStart: async () => ({ ok: true }), runImageDraftStart: async () => ({ ok: true }),
    getAgentCommandSurface: () => surface,
  })
  vm.runInContext(at('mc-agent:start') + '\n' + at('mc-agent:send'), f.context)
  const event = { sender }
  return {
    sender,
    start: value => handlers.get('mc-agent:start')(event, value),
    send: value => handlers.get('mc-agent:send')(event, value),
  }
}

test('c5: the system quits while a first message is starting its session: the quit waits for the message, then finishes', async () => {
  const f = quitFixture()
  f.state.saving = false // nothing is saving yet: the session is still starting
  const window = electronWindow(f)
  const channels = agentChannels(f)
  const started = channels.start({ sessionId: 'seat-1' })
  await pause(20)
  f.context.app.quit() // SIGTERM 0.3 s after Send
  assert.equal(f.appShutdown.started, false, 'THE DEFECT: the quit closed the session the first message was starting')
  assert.equal((await started).ok, true)
  await pause(100)
  assert.equal(f.appShutdown.started, false, 'the quit went through between the start and the send it was for')
  f.state.saving = true // the renderer sends the message it started the session for
  await channels.send({ sessionId: 'seat-1', text: 'hello' })
  await waitFor(() => f.appShutdown.started)
  assert.equal(f.appShutdown.started, true, `the quit was dropped (calls: ${f.calls.join(', ')})`)
  assert.equal(f.prompts.length, 0, 'no notice for a message that was only starting')
  assert.equal(window.isDestroyed(), true)
})

test('c5: a start the host refuses does not hold the quit', async () => {
  const f = quitFixture()
  f.state.saving = false
  electronWindow(f)
  const channels = agentChannels(f)
  const started = channels.start({ sessionId: 'seat-2', refuse: true })
  await pause(20)
  f.context.app.quit()
  await started
  await waitFor(() => f.appShutdown.started, 800)
  assert.equal(f.appShutdown.started, true, 'a refused start kept the app open')
})

test('c5: a window that goes away while its first message is starting does not hold the quit', async () => {
  const f = quitFixture()
  f.state.saving = false
  electronWindow(f)
  const channels = agentChannels(f)
  const started = channels.start({ sessionId: 'seat-3' })
  await pause(20)
  f.context.app.quit()
  await started
  for (const gone of [...channels.sender.destroyed]) gone() // the renderer that would send it is gone
  await waitFor(() => f.appShutdown.started, 800)
  assert.equal(f.appShutdown.started, true, 'a start whose window is gone kept the app open')
})
