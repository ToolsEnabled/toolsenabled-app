import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import shutdownModule from '../../shell/research-shutdown.cjs'
import appQuit from '../../shell/app-shutdown.cjs'
import { createSettingsDraft } from '../../src/settings-draft.js'

const { createAppQuitGate } = appQuit
const { createAppShutdownCoordinator } = shutdownModule
const main = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
const settings = readFileSync(new URL('../../src/views/settings.js', import.meta.url), 'utf8')
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
function event() { return { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } } }
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
function unloadGuard(draft, { busy = false } = {}) {
  const first = settings.indexOf('  const onBeforeUnload = event => {')
  const last = settings.indexOf("  window.addEventListener('beforeunload'", first)
  assert.ok(first >= 0 && last > first)
  const context = { draft, maintenanceBusy: busy, workingProfileBusy: false, draftStatus: {} }
  vm.runInNewContext(`${settings.slice(first, last)}\nglobalThis.guard = onBeforeUnload`, context)
  return context
}
function transcriptGuard(context) {
  context.agentHost ||= null
  context.rendererPrefs ||= { snapshot: () => ({ fleetPending: false, fleetWriteError: null }), flushFleetDocuments: async () => ({ ok: true }) }
  context.refreshStorageRefusalNotice ||= () => {}
  const first = main.indexOf('function transcriptsCanQuit() {')
  const last = main.indexOf('\nlet transcriptCloseNoticePending', first)
  assert.ok(first >= 0 && last > first)
  vm.runInNewContext(main.slice(first, last), context)
}
function fixture() {
  const calls = [], windows = []
  const shutdown = createAppShutdownCoordinator({
    quit: () => calls.push('quit'), onBegin: () => calls.push('seal'),
    closeAgents: () => calls.push('close-writers'),
  })
  return { calls, windows, shutdown, quit: createAppQuitGate({ getWindows: () => windows, shutdown }) }
}

test('canceling close preserves an unsaved Settings draft and leaves every runtime service unsealed', async () => {
  const f = fixture(), draft = createSettingsDraft()
  let writes = 0
  draft.stage('sample', 2, async () => { writes++; return { ok: true } })
  const context = unloadGuard(draft)
  let closed = false, attempts = 0
  f.windows.push({ isDestroyed: () => closed, close() {
    attempts++
    const close = event(); context.guard(close)
    if (!close.defaultPrevented) closed = true
  } })
  const first = event(); f.quit(first); f.quit(event())
  assert.equal(first.defaultPrevented, true)
  assert.equal(attempts, 2)
  assert.equal(closed, false)
  assert.equal(f.shutdown.started, false)
  assert.deepEqual(f.calls, [])
  assert.equal(draft.value('sample'), 2)
  assert.equal(writes, 0)
  assert.match(context.draftStatus.textContent, /Save or discard/)
  await draft.save()
  assert.equal(writes, 1, 'the unchanged host remains usable after the refused close')
  f.quit(event()); assert.equal(closed, true)
  await f.quit(event())
  assert.deepEqual(f.calls, ['seal', 'close-writers', 'quit'])
})

test('a close during a pending save cannot stop its writer, and retry succeeds only after the save settles', async () => {
  const f = fixture(), saving = deferred(), draft = createSettingsDraft()
  let persisted = 0, closed = false
  draft.stage('sample', 3, async value => { await saving.promise; persisted = value; return { ok: true } })
  const context = unloadGuard(draft)
  f.windows.push({ isDestroyed: () => closed, close() {
    const close = event(); context.guard(close)
    if (!close.defaultPrevented) closed = true
  } })
  const writing = draft.save()
  f.quit(event())
  assert.equal(closed, false); assert.equal(f.shutdown.started, false)
  assert.equal(persisted, 0); assert.deepEqual(f.calls, [])
  assert.match(context.draftStatus.textContent, /finish saving/)
  saving.resolve(); await writing
  assert.equal(persisted, 3); assert.equal(draft.dirty, false)
  f.quit(event()); assert.equal(closed, true)
  await f.quit(event())
  assert.deepEqual(f.calls, ['seal', 'close-writers', 'quit'])
})

test('an active maintenance operation blocks unload, while a completed operation requiring restart does not', () => {
  const context = unloadGuard(createSettingsDraft(), { busy: true })
  const pending = event(); context.guard(pending)
  assert.equal(pending.defaultPrevented, true)
  assert.match(context.draftStatus.textContent, /maintenance operation/)
  context.maintenanceBusy = false
  context.restartRequired = true
  const completed = event(); context.guard(completed)
  assert.equal(completed.defaultPrevented, false)
})

test('shutdown waits for every live window and preserves the existing bounded coordinator flight', async () => {
  const f = fixture()
  let secondClosed = false
  f.windows.push({ isDestroyed: () => false, close() {} }, { isDestroyed: () => secondClosed, close() { secondClosed = true } })
  f.quit(event())
  assert.equal(secondClosed, true)
  assert.deepEqual(f.calls, [])
  f.windows.splice(0)
  const first = f.quit(event())
  assert.equal(f.quit(event()), first)
  await first
  assert.equal(f.quit(event()), undefined)
  assert.deepEqual(f.calls, ['seal', 'close-writers', 'quit'])
})

test('actual agent close warning uses normal close, honors a renderer veto, and asks again after that veto', async () => {
  const closeStart = main.indexOf("  win.on('close', (event) => {")
  const closeEnd = main.indexOf('  /* The page\'s "this is what I am showing"', closeStart)
  const vetoStart = main.indexOf("  window.webContents.on('will-prevent-unload', () => {")
  const vetoEnd = main.indexOf('\n  })', vetoStart) + '\n  })'.length
  assert.ok(closeStart >= 0 && closeEnd > closeStart && vetoStart >= 0)
  let closeHandler, vetoHandler, prompts = 0, closes = 0
  const responses = [deferred(), deferred()]
  const window = { isDestroyed: () => false,
    on(name, callback) { assert.equal(name, 'close'); closeHandler = callback },
    webContents: { on(name, callback) { assert.equal(name, 'will-prevent-unload'); vetoHandler = callback } },
    close() { closes++; const next = event(); closeHandler(next); if (!next.defaultPrevented) vetoHandler() },
    destroy() { assert.fail('A native warning must not destroy an unsaved renderer') },
  }
  const context = { window, win: window, quitWithoutWindowClose: false, runningAgentCount: () => 1,
    nodeTranscripts: { getStorageStatus: () => ({ durable: true, pendingWrites: 0 }) },
    transcriptCapture: { hasPendingWrites: () => false },
    rendererPrefs: { snapshot: () => ({ values: {} }) }, CLOSE_WARNING_KEY: 'fixture',
    closeEndsAgentsWarning: () => ({ message: 'fixture', detail: 'fixture' }),
    dialog: { showMessageBox() { return responses[prompts++].promise } },
  }
  transcriptGuard(context)
  vm.runInNewContext(`let closeRequested = false; let closeWarningPending = false;\n${main.slice(vetoStart, vetoEnd)}\n${main.slice(closeStart, closeEnd)}`, context)
  closeHandler(event()); closeHandler(event())
  assert.equal(prompts, 1, 'repeated quit does not stack warnings')
  responses[0].resolve({ response: 0, checkboxChecked: false }); await flush()
  assert.equal(closes, 1)
  closeHandler(event()); assert.equal(prompts, 2)
  responses[1].resolve({ response: 1, checkboxChecked: false }); await flush()
  assert.equal(closes, 1, 'Keep working does not retry native close')
})

function quitWarningFixture({ failClose = false, diskFull = false, pendingWrites = 0, pendingCapture = false } = {}) {
  const closeStart = main.indexOf("  win.on('close', (event) => {")
  const closeEnd = main.indexOf('  /* The page\'s "this is what I am showing"', closeStart)
  const vetoStart = main.indexOf("  window.webContents.on('will-prevent-unload', () => {")
  const vetoEnd = main.indexOf('\n  })', vetoStart) + '\n  })'.length
  const quitStart = main.indexOf('const appQuitGate = createAppQuitGate(')
  const quitEnd = main.indexOf('\nwireSingleInstance({', quitStart)
  assert.ok(closeStart >= 0 && closeEnd > closeStart && vetoStart >= 0 && quitStart >= 0 && quitEnd > quitStart)
  const f = fixture(), draft = createSettingsDraft(), answer = deferred()
  draft.stage('sample', 7, async () => ({ ok: true }))
  const unload = unloadGuard(draft)
  let closeHandler, vetoHandler, beforeQuit, closed = false, prompts = 0
  const window = {
    isDestroyed: () => closed,
    on(name, callback) { assert.equal(name, 'close'); closeHandler = callback },
    webContents: { on(name, callback) { assert.equal(name, 'will-prevent-unload'); vetoHandler = callback } },
    close() {
      if (failClose) { failClose = false; throw new Error('fixture-close-failed') }
      const closing = event(); closeHandler(closing)
      if (closing.defaultPrevented) return
      const unloading = event(); unload.guard(unloading)
      if (unloading.defaultPrevented) vetoHandler()
      else closed = true
    },
    destroy() { assert.fail('The quit gate must not destroy an unsaved renderer') },
  }
  f.windows.push(window)
  const context = {
    window, win: window, createAppQuitGate, appShutdown: f.shutdown,
    nodeTranscripts: { getStorageStatus: () => ({ durable: !diskFull, pendingWrites }) },
    transcriptCapture: { hasPendingWrites: () => pendingCapture },
    reportUnsavedTranscriptClose() {},
    BrowserWindow: { getAllWindows: () => f.windows },
    app: { on(name, callback) { assert.equal(name, 'before-quit'); beforeQuit = callback } },
    exitRecord: { writeExitRecord() {} }, runningAgentCount: () => 1,
    rendererPrefs: { snapshot: () => ({ values: {} }) }, CLOSE_WARNING_KEY: 'fixture',
    closeEndsAgentsWarning: () => ({ message: 'fixture', detail: 'fixture' }),
    dialog: { showMessageBox() { prompts++; return answer.promise } },
  }
  transcriptGuard(context)
  vm.runInNewContext(`let closeRequested = false; let closeWarningPending = false;\n${main.slice(vetoStart, vetoEnd)}\n${main.slice(closeStart, closeEnd)}\n${main.slice(quitStart, quitEnd)}`, context)
  return { ...f, draft, window, answer, beforeQuit: e => beforeQuit(e),
    get prompts() { return prompts }, get closed() { return closed } }
}

test('quit-gate closes bypass the agent warning, preserve drafts, and rearm manual close warnings', async () => {
  const f = quitWarningFixture()
  const quitting = event(); f.beforeQuit(quitting)
  assert.equal(quitting.defaultPrevented, true)
  assert.equal(f.prompts, 0, 'the quit gate must not wait for an unanswered agent warning')
  assert.equal(f.closed, false, 'the real renderer guard still vetoes an unsaved draft')
  assert.equal(f.draft.value('sample'), 7)
  assert.equal(f.draft.dirty, true)
  assert.equal(f.shutdown.started, false)
  assert.deepEqual(f.calls, [])

  f.window.close()
  assert.equal(f.prompts, 1, 'a later manual close must ask again after the renderer veto')
  f.answer.resolve({ response: 1, checkboxChecked: false }); await flush()
  assert.equal(f.closed, false)
  await f.draft.save()
  f.beforeQuit(event())
  assert.equal(f.closed, true)
  assert.equal(f.prompts, 1)
  await f.beforeQuit(event())
  assert.deepEqual(f.calls, ['seal', 'close-writers', 'quit'])
})

test('a throwing quit-gate close restores the next manual agent warning', async () => {
  const f = quitWarningFixture({ failClose: true })
  assert.throws(() => f.beforeQuit(event()), /fixture-close-failed/)
  assert.equal(f.shutdown.started, false)
  assert.deepEqual(f.calls, [])
  f.window.close()
  assert.equal(f.prompts, 1, 'failed gate close must not leave the warning bypass armed')
  f.answer.resolve({ response: 1, checkboxChecked: false }); await flush()
  assert.equal(f.closed, false)
  assert.equal(f.draft.dirty, true)
})

test('real window-close and app-quit handlers keep an unsaved transcript window and host alive', async () => {
  const f = quitWarningFixture({ diskFull: true })
  await f.draft.save()
  f.beforeQuit(event())
  f.window.close()
  assert.equal(f.closed, false, 'known RAM-only transcript changes must keep the native window open')
  assert.equal(f.prompts, 0, 'the ordinary close-and-end-agents prompt must not override disk retention')
  assert.equal(f.shutdown.started, false)
  assert.deepEqual(f.calls, [], 'no host shutdown can begin while the transcript has no durable copy')
})

test('late transcript refusal blocks bounded coordinator exit, including its timeout, until an explicit saved retry', async () => {
  let durable = true, timer, quits = 0, notices = 0, reports = 0
  const agents = deferred()
  const coordinator = createAppShutdownCoordinator({
    quit: () => { quits++ }, closeAgents: () => agents.promise,
    canQuit: () => durable, onRefusal: () => { notices++ },
    onComplete: () => { reports++ },
    schedule: callback => { timer = callback; return 1 }, unschedule() {},
  })
  const flight = coordinator.beforeQuit(event())
  durable = false
  timer()
  await flush()
  assert.equal(quits, 0, 'the timeout cannot discard a newly discovered unsaved transcript')
  assert.equal(reports, 0, 'blocked shutdown cannot publish a completed observation')
  assert.equal(notices, 1)
  agents.resolve()
  await flush()
  assert.equal(quits, 0)
  assert.equal(notices, 1, 'one blocked shutdown has one retained notice')
  durable = true
  await coordinator.beforeQuit(event())
  await flight
  assert.equal(quits, 1)
  assert.equal(reports, 1)
})

for (const pending of [{ pendingWrites: 1 }, { pendingCapture: true }]) {
  test('real quit waits for admitted writes before their storage result: ' + JSON.stringify(pending), async () => {
    const f = quitWarningFixture(pending)
    await f.draft.save()
    f.beforeQuit(event())
    f.window.close()
    assert.equal(f.closed, false)
    assert.equal(f.shutdown.started, false)
    assert.deepEqual(f.calls, [], 'pending storage is not permission to stop its producer')
  })
}

test('retained native refusal retries saving only on explicit choice and quits only after successful save', async () => {
  const first = main.indexOf('let transcriptCloseNoticePending = false')
  const last = main.indexOf('\nconst appQuitGate =', first)
  assert.ok(first >= 0 && last > first)
  let response, choices = [], retries = 0, quits = 0, durable = false
  const context = {
    nodeTranscripts: {
      getStorageStatus: () => ({ durable, ...(durable ? {} : { storageError: { message: 'Disk is full (ENOSPC).' } }) }),
      retry: async () => { retries++; return { durable } },
    },
    transcriptCapture: { getStorageStatus: () => ({ durable: true, pendingWrites: 0 }), hasPendingWrites: () => false,
      retry: async () => ({ ok: true, durable: true }) },
    dialog: { showMessageBox(options) { choices.push(options); response = deferred(); return response.promise } },
    appShutdown: { started: true }, app: { quit() { quits++ } },
  }
  transcriptGuard(context)
  vm.runInNewContext(main.slice(first, last), context)
  context.reportUnsavedTranscriptClose()
  context.reportUnsavedTranscriptClose()
  assert.equal(choices.length, 1, 'repeated close does not stack notices')
  assert.match(choices[0].message, /ENOSPC/)
  assert.deepEqual(Array.from(choices[0].buttons), ['Retry saving', 'Keep ToolsEnabled open'])
  response.resolve({ response: 1 }); await flush()
  assert.equal(retries, 0)
  context.reportUnsavedTranscriptClose()
  response.resolve({ response: 0 }); await flush()
  assert.equal(retries, 1); assert.equal(quits, 0, 'a refused retry cannot quit')
  durable = true
  context.reportUnsavedTranscriptClose()
  response.resolve({ response: 0 }); await new Promise(resolve => setImmediate(resolve))
  assert.equal(retries, 2); assert.equal(quits, 1)
})

test('main coordinator wiring checks pending capture and retained transcript state before exit', async () => {
  const first = main.indexOf('const appShutdown = createAppShutdownCoordinator({')
  const last = main.indexOf('\n/* A local-data erase', first)
  assert.ok(first >= 0 && last > first)
  let options, durable = true, pending = false, refusals = 0
  const context = {
    createAppShutdownCoordinator(value) { options = value; return {} },
    nodeTranscripts: { getStorageStatus: () => ({ durable, pendingWrites: 0 }) },
    transcriptCapture: { hasPendingWrites: () => pending },
    reportUnsavedTranscriptClose() { refusals++ },
  }
  transcriptGuard(context)
  vm.runInNewContext(main.slice(first, last), context)
  assert.equal(options.canQuit(), true)
  pending = true; assert.equal(options.canQuit(), false)
  pending = false; durable = false; assert.equal(options.canQuit(), false)
  options.onRefusal(); assert.equal(refusals, 1)
})
