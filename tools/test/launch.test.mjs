import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const childProcess = require_('node:child_process')
const launchModule = require_.resolve('../../shell/launch.cjs')
const electronModule = require_.resolve('electron')

/* launch.cjs is intentionally a side-effectful CommonJS entry point.  This
 * harness replaces both things at that boundary: Electron is only a harmless
 * path, and spawn records the request instead of creating a process. */
function loadLauncher() {
  const child = new EventEmitter()
  const calls = []
  const exits = []
  const errors = []
  const originalSpawn = childProcess.spawn
  const originalExit = process.exit
  const originalError = console.error
  const cachedElectron = require_.cache[electronModule]

  childProcess.spawn = (...args) => {
    calls.push(args)
    return child
  }
  process.exit = (code) => { exits.push(code) }
  console.error = (...args) => { errors.push(args) }
  require_.cache[electronModule] = {
    id: electronModule,
    filename: electronModule,
    loaded: true,
    exports: '/test-only/electron',
    children: [],
    paths: [],
  }
  delete require_.cache[launchModule]
  require_(launchModule)

  return {
    calls,
    child,
    errors,
    exits,
    restore() {
      delete require_.cache[launchModule]
      childProcess.spawn = originalSpawn
      process.exit = originalExit
      console.error = originalError
      if (cachedElectron === undefined) delete require_.cache[electronModule]
      else require_.cache[electronModule] = cachedElectron
    },
  }
}

test('shell/launch.cjs starts Electron with a safe inherited environment', () => {
  const previous = {
    ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE,
    ELECTRON_NO_ATTACH_CONSOLE: process.env.ELECTRON_NO_ATTACH_CONSOLE,
    LAUNCH_TEST_PRESERVED: process.env.LAUNCH_TEST_PRESERVED,
  }
  process.env.ELECTRON_RUN_AS_NODE = '1'
  process.env.ELECTRON_NO_ATTACH_CONSOLE = '1'
  process.env.LAUNCH_TEST_PRESERVED = 'kept'

  const run = loadLauncher()
  try {
    assert.equal(run.calls.length, 1, 'the launcher must make exactly one spawn request')
    const [executable, args, options] = run.calls[0]
    assert.equal(executable, '/test-only/electron', 'the spawn command must be Electron')
    assert.deepEqual(args, [path.resolve('shell/main.cjs')], 'Electron must receive the main-process entry point')
    assert.equal(options.env.LAUNCH_TEST_PRESERVED, 'kept', 'ordinary inherited environment must be preserved')
    assert.equal('ELECTRON_RUN_AS_NODE' in options.env, false, 'Node mode must not reach the Electron main process')
    assert.equal('ELECTRON_NO_ATTACH_CONSOLE' in options.env, false, 'the inherited console suppression must not reach Electron')
    assert.deepEqual(
      { stdio: options.stdio, detached: options.detached },
      { stdio: 'inherit', detached: false },
      'the interactive launcher must retain the terminal and remain attached',
    )
  } finally {
    run.restore()
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test('shell/launch.cjs reports a spawn refusal with its reason and fails', () => {
  const run = loadLauncher()
  try {
    run.child.emit('error', new Error('test permission refusal'))
    assert.deepEqual(run.exits, [1], 'a spawn refusal must terminate as a failure')
    assert.equal(run.errors.length, 1, 'a spawn refusal must be reported once')
    assert.match(
      String(run.errors[0][0]),
      /test permission refusal/,
      'the refusal report must retain the operating-system reason',
    )
  } finally {
    run.restore()
  }
})

test('shell/launch.cjs mirrors definite exits but treats an unavailable exit code as clean', () => {
  const run = loadLauncher()
  try {
    run.child.emit('exit', 23)
    run.child.emit('exit', null)
    assert.deepEqual(
      run.exits,
      [23, 0],
      'a definite Electron result must be preserved while a missing code receives the documented neutral fallback',
    )
  } finally {
    run.restore()
  }
})
