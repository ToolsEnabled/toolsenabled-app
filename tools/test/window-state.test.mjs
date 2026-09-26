import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

import windowState from '../../shell/window-state.cjs'

const { restoredWindowState, shellStateRecord } = windowState
const primary = { x: 0, y: 0, width: 1920, height: 1040 }

test('restoring a window preserves both glow themes', () => {
  for (const theme of ['ember', 'cobalt']) {
    assert.equal(restoredWindowState({ theme }, [primary]).theme, theme)
    assert.equal(restoredWindowState({ theme, width: 3000, height: 2000 }, [primary]).theme, theme)
  }
})

test('non-object and malformed shell state falls back to a visible default', () => {
  for (const value of [null, undefined, true, 7, 'tan', []]) {
    assert.deepEqual(shellStateRecord(value), {})
    assert.deepEqual(restoredWindowState(value, [primary]), {
      theme: 'white',
      maximized: false,
      bounds: {
        x: 240,
        y: 70,
        width: 1440,
        height: 900,
        minWidth: 980,
        minHeight: 640,
      },
    })
  }
})

test('valid Tan state and visible bounds are preserved', () => {
  assert.deepEqual(restoredWindowState({
    theme: 'tan',
    maximized: true,
    x: 120,
    y: 80,
    width: 1280,
    height: 760,
  }, [primary]), {
    theme: 'tan',
    maximized: true,
    bounds: {
      x: 120,
      y: 80,
      width: 1280,
      height: 760,
      minWidth: 980,
      minHeight: 640,
    },
  })
})

test('invalid fields never reach BrowserWindow options', () => {
  const restored = restoredWindowState({
    theme: 'constructor',
    maximized: 'true',
    x: Number.MAX_SAFE_INTEGER,
    y: NaN,
    width: '1440',
    height: -1,
  }, [primary])

  assert.equal(restored.theme, 'white')
  assert.equal(restored.maximized, false)
  assert.deepEqual(restored.bounds, {
    x: 240,
    y: 70,
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 640,
  })
  for (const value of Object.values(restored.bounds)) assert.equal(Number.isInteger(value), true)
})

test('bounds from a removed display are centered on the current primary display', () => {
  const restored = restoredWindowState({
    theme: 'black',
    x: -2200,
    y: 100,
    width: 1600,
    height: 900,
  }, [primary])

  assert.equal(restored.theme, 'black')
  assert.deepEqual(restored.bounds, {
    x: 160,
    y: 70,
    width: 1600,
    height: 900,
    minWidth: 980,
    minHeight: 640,
  })
})

test('a low-resolution display produces internally consistent dimensions', () => {
  const restored = restoredWindowState({
    x: 0,
    y: 0,
    width: 1440,
    height: 900,
  }, [{ x: 0, y: 0, width: 800, height: 600 }])

  assert.deepEqual(restored.bounds, {
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    minWidth: 800,
    minHeight: 600,
  })
})

test('visible bounds on a secondary display remain on that display', () => {
  const secondary = { x: -1600, y: 0, width: 1600, height: 900 }
  const restored = restoredWindowState({
    theme: 'tan',
    x: -1500,
    y: 50,
    width: 1200,
    height: 700,
  }, [primary, secondary])

  assert.deepEqual(restored.bounds, {
    x: -1500,
    y: 50,
    width: 1200,
    height: 700,
    minWidth: 980,
    minHeight: 640,
  })
})

test('bounds spanning adjacent displays are not moved onto only one display', () => {
  const secondary = { x: 1920, y: 0, width: 1600, height: 1040 }
  const restored = restoredWindowState({
    x: 1500,
    y: 100,
    width: 1000,
    height: 700,
  }, [primary, secondary])

  assert.deepEqual(restored.bounds, {
    x: 1500,
    y: 100,
    width: 1000,
    height: 700,
    minWidth: 980,
    minHeight: 640,
  })
})

test('shrinking an oversized restored window cannot move its final bounds off-screen', () => {
  const secondary = { x: -800, y: 0, width: 800, height: 600 }
  const restored = restoredWindowState({
    x: -1550,
    y: 0,
    width: 1600,
    height: 600,
  }, [primary, secondary])

  assert.deepEqual(restored.bounds, {
    x: -800,
    y: 0,
    width: 800,
    height: 600,
    minWidth: 800,
    minHeight: 600,
  })
})

/* T1555: execute the shell's persistence handlers with inert window, timer and
   filesystem dependencies. The handler source and readState/writeState source
   are loaded from shell/main.cjs so these assertions exercise the shipped
   behavior rather than checking source spellings. */
function createPersistenceHarness(initialState = {}) {
  const main = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
  const stateStart = main.indexOf('const STATE_FILE = () =>')
  const stateEnd = main.indexOf('/* The theme the first frame should be painted', stateStart)
  const handlerStart = main.indexOf('const persistBounds = () => {')
  const handlerEnd = main.indexOf('// Ctrl+Plus', handlerStart)
  assert.ok(stateStart >= 0 && stateEnd > stateStart, 'shell state reader/writer source is missing')
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart, 'window persistence handler source is missing')

  const stateSource = main.slice(stateStart, stateEnd)
  const handlerSource = main.slice(handlerStart, handlerEnd)
  const userData = '/inert/user-data'
  const statePath = path.join(userData, 'shell-state.json')
  let stored = JSON.stringify(initialState)
  const writes = []
  const timers = new Map()
  let nextTimer = 0
  let now = 0

  const fs = {
    readFileSync() {
      return stored
    },
    writeFileSync(file, text) {
      assert.equal(file, statePath)
      writes.push(text)
      stored = text
    },
  }

  const win = {
    normalBounds: { x: 0, y: 0, width: 1440, height: 900 },
    maximized: false,
    listeners: new Map(),
    on(event, handler) {
      const handlers = this.listeners.get(event) || []
      handlers.push(handler)
      this.listeners.set(event, handlers)
      return this
    },
    emit(event) {
      for (const handler of this.listeners.get(event) || []) handler()
    },
    getNormalBounds() {
      return { ...this.normalBounds }
    },
    isMaximized() {
      return this.maximized
    },
  }

  const setTimer = (callback, delay) => {
    const timer = { at: now + delay, callback, id: ++nextTimer }
    timers.set(timer.id, timer)
    return timer.id
  }
  const clearTimer = id => {
    timers.delete(id)
  }
  const advance = milliseconds => {
    assert.equal(Number.isFinite(milliseconds), true)
    assert.equal(milliseconds >= 0, true)
    now += milliseconds
    while (true) {
      const due = [...timers.values()]
        .filter(timer => timer.at <= now)
        .sort((left, right) => left.at - right.at)
      if (due.length === 0) return
      for (const timer of due) {
        if (!timers.delete(timer.id)) continue
        timer.callback()
      }
    }
  }

  const sandbox = {
    app: { getPath: () => userData },
    clearTimeout: clearTimer,
    fs,
    path,
    setTimeout: setTimer,
    shellStateRecord,
    win,
  }
  vm.createContext(sandbox)
  vm.runInContext([
    'function installPersistence() {',
    stateSource,
    handlerSource,
    'return { readState, writeState, eraseData: () => { localDataErased = true } }',
    '}',
    'globalThis.installPersistence = installPersistence',
  ].join('\n'), sandbox)
  const installed = sandbox.installPersistence()

  return {
    ...installed,
    advance,
    currentState: () => JSON.parse(stored),
    statePath,
    win,
    writes,
  }
}

test('the shell saves the window bounds on the events Linux actually sends', () => {
  const secondary = { x: -1600, y: 0, width: 1600, height: 900 }
  const initialState = { theme: 'tan', zoom: 1.25, port: 4603 }
  const harness = createPersistenceHarness(initialState)
  assert.deepEqual(JSON.parse(JSON.stringify(harness.readState())), initialState)

  harness.win.normalBounds = { x: -1490, y: 50, width: 1200, height: 700 }
  harness.win.emit('resize')
  harness.advance(399)
  assert.equal(harness.writes.length, 0)
  harness.win.normalBounds = { x: -1500, y: 60, width: 1200, height: 700 }
  harness.win.emit('move')
  harness.advance(399)
  assert.equal(harness.writes.length, 0)
  harness.advance(1)
  assert.equal(harness.writes.length, 1)
  assert.deepEqual(harness.currentState(), {
    ...initialState,
    x: -1500,
    y: 60,
    width: 1200,
    height: 700,
    maximized: false,
  })

  const restored = restoredWindowState(harness.currentState(), [primary, secondary])
  assert.equal(restored.theme, 'tan')
  assert.equal(restored.maximized, false)
  assert.deepEqual(restored.bounds, {
    x: -1500,
    y: 60,
    width: 1200,
    height: 700,
    minWidth: 980,
    minHeight: 640,
  })

  harness.win.normalBounds = { x: -1400, y: 80, width: 1180, height: 680 }
  harness.win.emit('resize')
  harness.advance(399)
  assert.equal(harness.writes.length, 1)
  harness.win.normalBounds = { x: -1380, y: 90, width: 1180, height: 680 }
  harness.win.emit('move')
  harness.win.emit('close')
  assert.equal(harness.writes.length, 2)
  harness.advance(400)
  assert.equal(harness.writes.length, 2)
  assert.deepEqual(harness.currentState(), {
    ...initialState,
    x: -1380,
    y: 90,
    width: 1180,
    height: 680,
    maximized: false,
  })
})

test('the shell persists Windows bounds and maximize transitions', () => {
  const initialState = { theme: 'cobalt', zoom: 1.1, port: 4603 }
  const harness = createPersistenceHarness(initialState)

  harness.win.normalBounds = { x: 100, y: 100, width: 1200, height: 700 }
  harness.win.emit('resized')
  assert.deepEqual(harness.currentState(), {
    ...initialState,
    x: 100,
    y: 100,
    width: 1200,
    height: 700,
    maximized: false,
  })

  harness.win.normalBounds = { x: 120, y: 120, width: 1180, height: 680 }
  harness.win.emit('moved')
  assert.deepEqual(harness.currentState(), {
    ...initialState,
    x: 120,
    y: 120,
    width: 1180,
    height: 680,
    maximized: false,
  })

  harness.win.normalBounds = { x: 200, y: 220, width: 1100, height: 660 }
  harness.win.maximized = true
  harness.win.emit('maximize')
  assert.deepEqual(harness.currentState(), {
    ...initialState,
    x: 200,
    y: 220,
    width: 1100,
    height: 660,
    maximized: true,
  })

  harness.win.normalBounds = { x: 240, y: 260, width: 1080, height: 640 }
  harness.win.maximized = false
  harness.win.emit('unmaximize')
  assert.deepEqual(harness.currentState(), {
    ...initialState,
    x: 240,
    y: 260,
    width: 1080,
    height: 640,
    maximized: false,
  })
})

test('the persistence handler refuses to recreate erased local data', () => {
  const initialState = { theme: 'cobalt', zoom: 1.1, port: 4603 }
  const harness = createPersistenceHarness(initialState)
  harness.eraseData()
  harness.win.normalBounds = { x: 40, y: 50, width: 1100, height: 700 }
  harness.win.emit('resized')
  harness.win.emit('resize')
  harness.advance(400)
  harness.win.emit('close')
  harness.advance(400)

  assert.equal(harness.writes.length, 0)
  assert.deepEqual(harness.currentState(), initialState)
})
