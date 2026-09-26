import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { APP_EXE, APP_MARKER, main } from '../smoke-packaged.mjs'

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'smoke-packaged-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

function fakeChild(pid = 4242) {
  const child = new EventEmitter()
  child.pid = pid
  child.exitCode = null
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => true
  return child
}

test('missing packaged directory throws with a clear message', async (t) => {
  const parent = await temporaryDirectory(t)
  const missing = path.join(parent, 'not-built')
  await assert.rejects(main(missing), (error) => {
    assert.match(error.message, /Packaged app directory does not exist/)
    assert.match(error.message, /not-built/)
    return true
  })
})

test('directory without ToolsEnabled.exe throws', async (t) => {
  const directory = await temporaryDirectory(t)
  await assert.rejects(main(directory), (error) => {
    assert.match(error.message, /Packaged executable does not exist/)
    assert.match(error.message, /ToolsEnabled\.exe/)
    return true
  })
})

test('application that never binds times out and terminates', async (t) => {
  const directory = await temporaryDirectory(t)
  await writeFile(path.join(directory, APP_EXE), 'test placeholder')
  const child = fakeChild()
  let now = 0
  let terminated = false

  await assert.rejects(
    main(directory, {
      spawn: () => child,
      fetch: async () => { throw new Error('not listening') },
      sleep: async () => { now += 5 },
      now: () => now,
      findExistingInstances: async () => [],
      getWindowTitle: async () => '',
      terminateProcessTree: async () => { terminated = true },
      makeSmokeProfileDirectory: async () => path.join(directory, 'smoke-profile'),
      removeSmokeProfileDirectory: async () => {},
      timeoutMs: 10,
      pollIntervalMs: 1,
      requestTimeoutMs: 10,
      log: () => {},
    }),
    (error) => {
      assert.match(error.message, /Timed out after 10ms/)
      return true
    },
  )

  assert.equal(terminated, true)
})

test('existing ToolsEnabled instance refuses launch without killing it', async (t) => {
  const directory = await temporaryDirectory(t)
  await writeFile(path.join(directory, APP_EXE), 'test placeholder')

  await assert.rejects(
    main(directory, {
      spawn: () => { throw new Error('spawn must not be called') },
      findExistingInstances: async () => [1234],
      log: () => {},
    }),
    /another instance is running; close it and re-run \(PID 1234\)/,
  )
})

test('successful probe reports the serving port, status, and marker and terminates', async (t) => {
  const directory = await temporaryDirectory(t)
  await writeFile(path.join(directory, APP_EXE), 'test placeholder')
  const child = fakeChild()
  const messages = []
  let terminated = false
  let spawnOptions
  const originalRunAsNode = process.env.ELECTRON_RUN_AS_NODE
  const originalNoAttach = process.env.ELECTRON_NO_ATTACH_CONSOLE
  process.env.ELECTRON_RUN_AS_NODE = '1'
  process.env.ELECTRON_NO_ATTACH_CONSOLE = '1'

  let result
  try {
    result = await main(directory, {
      spawn: (_executable, _arguments, options) => {
        spawnOptions = options
        return child
      },
      fetch: async (url) => {
        if (url !== 'http://127.0.0.1:4604/') throw new Error('not listening')
        return {
          status: 200,
          text: async () => `<!doctype html>${APP_MARKER}`,
        }
      },
      findExistingInstances: async () => [],
      getWindowTitle: async () => '',
      terminateProcessTree: async () => { terminated = true },
      makeSmokeProfileDirectory: async () => path.join(directory, 'smoke-profile'),
      removeSmokeProfileDirectory: async () => {},
      timeoutMs: 100,
      pollIntervalMs: 1,
      requestTimeoutMs: 10,
      log: (message) => messages.push(message),
    })
  } finally {
    if (originalRunAsNode === undefined) delete process.env.ELECTRON_RUN_AS_NODE
    else process.env.ELECTRON_RUN_AS_NODE = originalRunAsNode
    if (originalNoAttach === undefined) delete process.env.ELECTRON_NO_ATTACH_CONSOLE
    else process.env.ELECTRON_NO_ATTACH_CONSOLE = originalNoAttach
  }

  assert.deepEqual(result, { port: 4604, status: 200, markerFound: true })
  assert.equal(terminated, true)
  assert.equal(spawnOptions.env.MC_SMOKE_HEADLESS, '1')
  assert.equal('ELECTRON_RUN_AS_NODE' in spawnOptions.env, false)
  assert.equal('ELECTRON_NO_ATTACH_CONSOLE' in spawnOptions.env, false)
  assert.equal(spawnOptions.windowsHide, true)
  assert.match(messages.join('\n'), /port=4604/)
  assert.match(messages.join('\n'), /http_status=200/)
  assert.match(messages.join('\n'), /marker_found=true/)
})

test('a fatal startup window fails smoke even after the HTTP marker responds', async (t) => {
  for (const title of ['Error', 'ToolsEnabled could not start']) {
    await t.test(title, async (t) => {
      const directory = await temporaryDirectory(t)
      await writeFile(path.join(directory, APP_EXE), 'test placeholder')
      const child = fakeChild()
      let terminated = false

      await assert.rejects(main(directory, {
        spawn: () => child,
        fetch: async () => ({ status: 200, text: async () => APP_MARKER }),
        findExistingInstances: async () => [],
        getWindowTitle: async () => title,
        terminateProcessTree: async () => { terminated = true },
        makeSmokeProfileDirectory: async () => path.join(directory, 'smoke-profile'),
        removeSmokeProfileDirectory: async () => {},
        timeoutMs: 100,
        log: () => {},
      }), /opened a fatal startup window/)

      assert.equal(terminated, true)
    })
  }
})

test('spawn is explicitly attached to the parent process with detached false', async (t) => {
  const directory = await temporaryDirectory(t)
  await writeFile(path.join(directory, APP_EXE), 'test placeholder')
  const child = fakeChild()
  let spawnOptions

  await main(directory, {
    spawn: (_executable, _arguments, options) => {
      spawnOptions = options
      return child
    },
    fetch: async () => ({ status: 200, text: async () => APP_MARKER }),
    findExistingInstances: async () => [],
    getWindowTitle: async () => '',
    terminateProcessTree: async () => {},
    makeSmokeProfileDirectory: async () => path.join(directory, 'smoke-profile'),
    removeSmokeProfileDirectory: async () => {},
    timeoutMs: 100,
    log: () => {},
  })

  assert.equal(spawnOptions.detached, false)
})

test('failure thrown mid-flight still terminates the process tree', async (t) => {
  const directory = await temporaryDirectory(t)
  await writeFile(path.join(directory, APP_EXE), 'test placeholder')
  const child = fakeChild()
  let terminated = false

  await assert.rejects(main(directory, {
    spawn: () => child,
    fetch: async () => { throw new Error('not listening') },
    sleep: async () => { throw new Error('synthetic mid-flight failure') },
    findExistingInstances: async () => [],
    getWindowTitle: async () => '',
    terminateProcessTree: async () => { terminated = true },
    makeSmokeProfileDirectory: async () => path.join(directory, 'smoke-profile'),
    removeSmokeProfileDirectory: async () => {},
    timeoutMs: 100,
    log: () => {},
  }), /synthetic mid-flight failure/)

  assert.equal(terminated, true)
})

test('watchdog kills independently when normal termination stalls', async (t) => {
  const directory = await temporaryDirectory(t)
  await writeFile(path.join(directory, APP_EXE), 'test placeholder')
  const child = fakeChild()
  let releaseTermination
  const watchdogFired = new Promise((resolve) => { releaseTermination = resolve })
  let watchdogPid

  const result = await main(directory, {
    spawn: () => child,
    fetch: async () => ({ status: 200, text: async () => APP_MARKER }),
    findExistingInstances: async () => [],
    getWindowTitle: async () => '',
    terminateProcessTree: async () => { await watchdogFired },
    watchdogTerminateProcessTree: (watchedChild) => {
      watchdogPid = watchedChild.pid
      releaseTermination()
    },
    makeSmokeProfileDirectory: async () => path.join(directory, 'smoke-profile'),
    removeSmokeProfileDirectory: async () => {},
    timeoutMs: 5,
    watchdogGraceMs: 0,
    log: () => {},
  })

  assert.equal(watchdogPid, child.pid)
  assert.equal(result.markerFound, true)
})

test('caller-supplied profile directory is reused and not removed', async (t) => {
  const directory = await temporaryDirectory(t)
  await writeFile(path.join(directory, APP_EXE), 'test placeholder')
  const sharedProfile = path.join(directory, 'shared-profile')
  const previousProfile = process.env.MC_SMOKE_PROFILE_DIR
  let spawnArguments
  let madeProfile = false
  let removedProfile = false
  process.env.MC_SMOKE_PROFILE_DIR = sharedProfile

  try {
    await main(directory, {
      spawn: (_executable, arguments_) => {
        spawnArguments = arguments_
        return fakeChild()
      },
      fetch: async () => ({ status: 200, text: async () => APP_MARKER }),
      findExistingInstances: async () => [],
      getWindowTitle: async () => '',
      terminateProcessTree: async () => {},
      makeSmokeProfileDirectory: async () => { madeProfile = true },
      removeSmokeProfileDirectory: async () => { removedProfile = true },
      timeoutMs: 100,
      log: () => {},
    })
  } finally {
    if (previousProfile === undefined) delete process.env.MC_SMOKE_PROFILE_DIR
    else process.env.MC_SMOKE_PROFILE_DIR = previousProfile
  }

  assert.equal(spawnArguments[0], `--user-data-dir=${path.resolve(sharedProfile)}`)
  assert.equal(madeProfile, false)
  assert.equal(removedProfile, false)
})
