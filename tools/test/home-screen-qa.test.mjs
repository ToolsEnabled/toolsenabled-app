import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import test from 'node:test'

const require = createRequire(import.meta.url)
const qa = require('../home-screen-qa.cjs')

test('DevTools port discovery distinguishes absent from unreadable and only caches success', () => {
  const originalReadFileSync = fs.readFileSync
  let reads = 0
  try {
    fs.readFileSync = () => {
      reads += 1
      const error = new Error('file table is full')
      error.code = 'EMFILE'
      throw error
    }
    qa.resetDevToolsPortForTest()
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.throws(
        () => qa.discoverDevToolsPort('/busy-profile'),
        (error) => error.code === 'ERR_DEVTOOLS_PORT_UNREADABLE'
          && /NOT claiming the file or application is absent/.test(error.message),
      )
    }
    assert.equal(reads, 2, 'a could-not-read result must not be cached or latched')

    fs.readFileSync = () => {
      reads += 1
      return '43210\n/devtools/browser/id\n'
    }
    qa.resetDevToolsPortForTest()
    assert.equal(qa.discoverDevToolsPort('/ready-profile'), 43210)
    assert.equal(qa.discoverDevToolsPort('/ready-profile'), 43210)
    assert.equal(reads, 3, 'a successful port read remains cached for the child lifetime')

    fs.readFileSync = () => 'not-a-port\n'
    qa.resetDevToolsPortForTest()
    assert.throws(
      () => qa.discoverDevToolsPort('/malformed-profile'),
      (error) => error.code === 'ERR_DEVTOOLS_PORT_INVALID'
        && /NOT claiming the file or application is absent/.test(error.message),
    )

    fs.readFileSync = () => {
      const error = new Error('not found')
      error.code = 'ENOENT'
      throw error
    }
    qa.resetDevToolsPortForTest()
    assert.equal(qa.discoverDevToolsPort('/starting-profile'), null)
  } finally {
    fs.readFileSync = originalReadFileSync
    qa.resetDevToolsPortForTest()
  }
})

test('Home selects exactly one explicit or legacy candidate and refuses ambiguous invocations', () => {
  const selected = path.resolve('selected candidate')
  for (const argv of [['selected candidate'], ['--release', 'selected candidate'], ['--release=selected candidate']]) {
    assert.equal(qa.homeReleaseArgument(argv), selected)
  }
  assert.match(qa.homeReleaseArgument([], 'linux'), /release[/\\]linux-unpacked$/)
  assert.match(qa.homeReleaseArgument([], 'win32'), /release[/\\]win-unpacked$/)
  for (const argv of [['--release'], ['--release='], [''], ['   '], ['--wat'], ['a', 'b'],
    ['--release', 'a', 'b'], ['--release', '--release=b'], ['--release=a', '--release=b']]) {
    assert.throws(() => qa.homeReleaseArgument(argv), /exactly one candidate/)
  }
  assert.throws(() => qa.homeReleaseArgument([], 'darwin'), /ownership support/)
})

test('all Home staging invocations select exact bytes without a checkout overlay', async () => {
  const calls = []
  const harness = { STAGE_EXACT_RELEASE: 'exact-release', async stage(...args) {
    calls.push(args)
    return { executable: path.resolve('ToolsEnabled.exe'), stageMode: args[2].mode }
  } }
  for (const argv of [[], ['fixture'], ['--release', 'fixture'], ['--release=fixture']]) {
    const result = await qa.stageHomeRelease('/fresh-scratch', argv, harness)
    assert.equal(result.stageMode, 'exact-release')
    assert.deepEqual(calls.at(-1), ['/fresh-scratch', qa.homeReleaseArgument(argv), { mode: 'exact-release' }])
  }
  await assert.rejects(qa.stageHomeRelease('/fresh-scratch', ['--release'], harness), /exactly one candidate/)
  assert.equal(calls.length, 4, 'malformed arguments never reach staging')
})

test('Home really copies tiny packaged byte fixtures and refuses an existing staging destination', async t => {
  if (!['linux', 'win32'].includes(process.platform)) return t.skip('native staging is Linux/Windows only')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home-stage-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const candidate = path.join(root, 'candidate')
  fs.mkdirSync(path.join(candidate, 'resources'), { recursive: true })
  fs.writeFileSync(path.join(candidate, 'resources', 'app.asar'), 'exact candidate archive fixture')
  fs.writeFileSync(path.join(candidate, process.platform === 'linux' ? 'toolsenabled' : 'ToolsEnabled.exe'),
    Buffer.from([127, 69, 76, 70, 1, 2, 3]), { mode: 0o755 })
  const { exactTreeManifest } = await import('../test-account-harness.mjs')
  const before = exactTreeManifest(candidate)
  const scratch = fs.mkdtempSync(path.join(root, 'scratch-'))
  const staged = await qa.stageHomeRelease(scratch, ['--release', candidate])
  assert.equal(staged.stageMode, 'exact-release')
  assert.equal(staged.sourceRelease, candidate)
  assert.deepEqual(exactTreeManifest(staged.appRoot), before)
  assert.deepEqual(exactTreeManifest(candidate), before)
  await assert.rejects(qa.stageHomeRelease(scratch, ['--release', candidate]), /existing destination/)
  assert.deepEqual(exactTreeManifest(candidate), before)
})

test('Home environment retains GUI requirements but no inherited credential, runtime override or D-Bus connection', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home-env-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const base = { HOME: '/owner', LOCALAPPDATA: '/owner/local', USERPROFILE: '/owner', CODEX_HOME: '/owner/.codex',
    OpenAI_API_KEY: 'fixture-only', ANTHROPIC_API_KEY: 'fixture-only', GOOGLE_APPLICATION_CREDENTIALS: '/owner/provider',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/owner/bus', XDG_RUNTIME_DIR: '/owner/runtime', SSH_AUTH_SOCK: '/owner/ssh',
    HTTPS_PROXY: 'fixture-proxy', NODE_OPTIONS: '--require=/owner/hook', ELECTRON_RUN_AS_NODE: '1',
    TOOLSENABLED_STATE_ROOT: '/owner/state', TOOLSENABLED_CAPABILITY_ROOT: '/owner/engine',
    DISPLAY: ':123', XAUTHORITY: '/qa-display-only', LANG: 'C.UTF-8', MC_SMOKE_HEADLESS: '1', SystemRoot: 'C:\\Windows' }
  for (const platform of ['linux', 'win32']) {
    const profile = path.join(root, platform)
    const env = qa.homeEnvironment(profile, base, platform)
    assert.equal(env.DISPLAY, ':123')
    assert.equal(env.MC_SMOKE_HEADLESS, '1')
    for (const key of ['OpenAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'SSH_AUTH_SOCK',
      'HTTPS_PROXY', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'TOOLSENABLED_STATE_ROOT', 'TOOLSENABLED_CAPABILITY_ROOT']) {
      assert.equal(env[key], undefined, key)
    }
    for (const key of ['LOCALAPPDATA', 'USERPROFILE', 'APPDATA', 'CODEX_HOME', 'TEMP', 'TMP']) {
      assert.ok(env[key].startsWith(profile + path.sep), `${key} stays inside the disposable profile`)
    }
    if (platform === 'linux') {
      assert.equal(env.HOME, path.join(profile, 'userprofile'))
      assert.equal(env.PATH, '/usr/bin:/bin')
      assert.equal(env.DBUS_SESSION_BUS_ADDRESS, `unix:path=${path.join(profile, 'absent-session-bus')}`)
      assert.equal(env.DBUS_SYSTEM_BUS_ADDRESS, `unix:path=${path.join(profile, 'absent-system-bus')}`)
      assert.equal(env.XDG_RUNTIME_DIR, path.join(profile, 'runtime'))
    } else assert.equal(env.DBUS_SESSION_BUS_ADDRESS, undefined)
  }
  assert.equal(base.HOME, '/owner', 'the parent environment is not rewritten')
})

function fakeOwner({ settles = true, receipt = { quiescent: true, started: true, exitedNormally: false, exitCode: null } } = {}) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  let destroyed = 0, cancelled = 0, unreferenced = 0, complete
  child.stdio = [child.stdout, child.stderr, new EventEmitter(), new EventEmitter()]
  child.stdio.forEach(stream => { stream.destroy = () => { destroyed++ } })
  child.unref = () => { unreferenced++ }
  const completion = new Promise(resolve => { complete = resolve })
  return { owner: { child, completion, cancel() { cancelled++; if (settles) complete(receipt); return completion } },
    complete, get cancelled() { return cancelled }, get destroyed() { return destroyed }, get unreferenced() { return unreferenced } }
}

const launch = { command: path.resolve('candidate/ToolsEnabled.exe'), args: ['--user-data-dir=/fresh/profile'],
  payloadRoot: path.resolve('candidate/resources/capability'), stateRoot: path.resolve('fresh/owner'), environment: { LANG: 'C' } }

test('Home delegates exact candidate, arguments and environment to its retained owner and awaits empty closure', async () => {
  const f = fakeOwner()
  const signals = new EventEmitter()
  let invoked
  const result = await qa.inspectOwnedHome(launch, async signal => {
    assert.equal(signal.aborted, false)
    assert.equal(f.cancelled, 0)
    return 'actual inspection value'
  }, { signals, spawnOwner(args) { invoked = args; return f.owner } })
  for (const key of Object.keys(launch)) assert.deepEqual(invoked[key], launch[key])
  assert.equal(typeof invoked.spawn, 'function')
  assert.equal(result.value, 'actual inspection value')
  assert.equal(result.error, undefined)
  assert.equal(result.cleanupConfirmed, true)
  assert.equal(f.cancelled, 1)
  assert.equal(f.destroyed, 0)
  assert.equal(signals.listenerCount('SIGINT') + signals.listenerCount('SIGTERM'), 0)
})

for (const kind of ['timeout', 'output', 'SIGINT', 'SIGTERM', 'early exit', 'inspection error']) {
  test(`Home ${kind} cannot pass and still closes only its owned descendants`, async () => {
    const f = fakeOwner()
    const signals = new EventEmitter()
    const result = await qa.inspectOwnedHome(launch, async () => {
      if (kind === 'output') f.owner.child.stderr.emit('data', Buffer.alloc(65))
      if (kind === 'SIGINT' || kind === 'SIGTERM') signals.emit(kind)
      if (kind === 'early exit') f.complete({ quiescent: true, started: true, exitedNormally: true, exitCode: 0 })
      if (kind === 'inspection error') throw new Error('fixture inspection failed')
      return new Promise(() => {})
    }, { signals, spawnOwner: () => f.owner, timeoutMs: 20, cleanupMs: 100, maxOutputBytes: 64 })
    assert.ok(result.error)
    assert.equal(result.cleanupConfirmed, true)
    assert.equal(f.cancelled, 1)
    assert.equal(f.destroyed, 0)
    assert.equal(signals.listenerCount('SIGINT') + signals.listenerCount('SIGTERM'), 0)
  })
}

test('Home never accepts a green inspection with unknown descendant closure', async () => {
  const f = fakeOwner({ settles: false })
  const result = await qa.inspectOwnedHome(launch, async () => 'green', {
    spawnOwner: () => f.owner, cleanupMs: 20, signals: new EventEmitter(),
  })
  assert.equal(result.value, 'green')
  assert.equal(result.cleanupConfirmed, false)
  assert.match(result.error.message, /UNCONFIRMED/)
  assert.equal(f.destroyed, 4)
  assert.equal(f.unreferenced, 1)
  f.complete({ quiescent: true, started: true })
})

test('Home never treats a failed owner constructor or not-started receipt as a pass', async () => {
  let inspected = false
  const failed = await qa.inspectOwnedHome(launch, async () => { inspected = true }, {
    spawnOwner() { throw new Error('fixture owner unavailable') }, signals: new EventEmitter(),
  })
  assert.equal(inspected, false)
  assert.equal(failed.cleanupConfirmed, false)
  assert.match(failed.error.message, /owner unavailable/)
  const f = fakeOwner({ receipt: { quiescent: true, started: false } })
  const notStarted = await qa.inspectOwnedHome(launch, async () => 'green', { spawnOwner: () => f.owner, signals: new EventEmitter() })
  assert.equal(notStarted.cleanupConfirmed, true)
  assert.match(notStarted.error.message, /never established/)
})

test('the actual Linux Home owner closes a disposable detached grandchild before returning', { timeout: 15_000 }, async t => {
  if (process.platform !== 'linux') return t.skip('actual Linux subreaper/pidfd proof; Windows Job execution is separate')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home-owner-native-test-'))
  const marker = path.join(root, 'grandchild-ready')
  const grandchild = "require('node:fs').writeFileSync(process.argv[1], 'ready'); setInterval(() => {}, 1000)"
  const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}, process.argv[1]], { detached: true, stdio: 'ignore' }); setInterval(() => {}, 1000)`
  const result = await qa.inspectOwnedHome({ command: process.execPath, args: ['-e', parent, marker],
    payloadRoot: root, stateRoot: root, environment: { PATH: '/usr/bin:/bin' }, platform: 'linux' }, async signal => {
    while (!fs.existsSync(marker)) {
      signal.throwIfAborted()
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    return fs.readFileSync(marker, 'utf8')
  }, { timeoutMs: 5_000, cleanupMs: 5_000, signals: new EventEmitter() })
  // Preserve the exact scratch if ownership cannot be established; no test
  // cleanup may erase evidence underneath an unknown live descendant.
  if (result.cleanupConfirmed) t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  assert.equal(result.error, undefined)
  assert.equal(result.value, 'ready')
  assert.equal(result.receipt.started, true)
  assert.equal(result.cleanupConfirmed, true)
})

test('Home port parsing refuses numeric spellings Chromium would not publish', () => {
  const read = fs.readFileSync
  try {
    for (const token of ['0', '-1', '65536', '1e3', '0x1234', '1.5', 'NaN', 'Infinity']) {
      fs.readFileSync = () => token + '\n'
      assert.throws(() => qa.readDevToolsPort('/fixture'), { code: 'ERR_DEVTOOLS_PORT_INVALID' })
    }
  } finally { fs.readFileSync = read }
})

function debuggerFixture({ address = 'ws://127.0.0.1:43210/devtools/page/fixture', mode = 'answer', pages = 1 } = {}) {
  const sockets = []
  class Socket extends EventTarget {
    constructor(url) {
      super()
      this.url = url
      sockets.push(this)
      // A referenced timer models an open socket's lifetime, even when the
      // timeout's AbortSignal itself is unreferenced by Node.
      this.hold = setInterval(() => {}, 1000)
      queueMicrotask(() => { if (mode !== 'never-open') this.dispatchEvent(new Event('open')) })
    }
    send() {
      if (mode === 'never-answer') return
      if (mode === 'early-close') return this.dispatchEvent(new Event('close'))
      const data = mode === 'malformed' ? '{' : JSON.stringify(mode === 'protocol-error'
        ? { id: 1, error: { message: 'fixture failure' } }
        : { id: 1, result: { result: { value: 'fixture home DOM result' } } })
      this.dispatchEvent(new MessageEvent('message', { data }))
    }
    close() { this.closed = true; clearInterval(this.hold) }
  }
  return { sockets, WebSocketImpl: Socket, async fetchImpl(url, options) {
    assert.equal(url, 'http://127.0.0.1:43210/json/list')
    assert.equal(options.redirect, 'error')
    return { ok: true, async json() { return Array.from({ length: pages }, () => ({ type: 'page', url: 'http://127.0.0.1:12345/', webSocketDebuggerUrl: address })) } }
  } }
}

test('Home debugger evaluates through the discovered loopback port and closes the socket', async () => {
  const f = debuggerFixture()
  assert.equal(await qa.evaluateOverCdp('location.hash', { ...f, port: 43210 }), 'fixture home DOM result')
  assert.equal(f.sockets.length, 1)
  assert.equal(f.sockets[0].closed, true)
})

for (const mode of ['never-open', 'never-answer', 'early-close', 'malformed', 'protocol-error']) {
  test(`Home debugger ${mode} is bounded and cannot look like a DOM pass`, async () => {
    const f = debuggerFixture({ mode })
    await assert.rejects(qa.evaluateOverCdp('location.hash', { ...f, port: 43210, timeoutMs: 20 }))
    assert.equal(f.sockets[0].closed, true)
  })
}

test('Home refuses ambiguous pages and off-port or non-loopback debugger addresses before connecting', async () => {
  for (const options of [{ pages: 0 }, { pages: 2 }, { address: 'ws://127.0.0.1:9226/devtools/page/fixture' },
    { address: 'ws://example.invalid:43210/devtools/page/fixture' }, { address: 'wss://127.0.0.1:43210/devtools/page/fixture' },
    { address: 'ws://user:fixture@127.0.0.1:43210/devtools/page/fixture' }]) {
    const f = debuggerFixture(options)
    await assert.rejects(qa.evaluateOverCdp('location.hash', { ...f, port: 43210 }))
    assert.equal(f.sockets.length, 0)
  }
})

test('Home debugger respects an already-cancelled owner before any request', async () => {
  const controller = new AbortController()
  controller.abort(new Error('owner cancelled'))
  let requested = false
  await assert.rejects(qa.evaluateOverCdp('location.hash', { port: 43210, signal: controller.signal,
    fetchImpl() { requested = true },
  }), /owner cancelled/)
  assert.equal(requested, false)
})

test('Home has no process census, numeric-PID kill, profile reuse or source-overlay escape', () => {
  const source = fs.readFileSync(new URL('../home-screen-qa.cjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /taskkill|Get-Process|process\.kill\(|child\.kill\(|STAGE_SOURCE_OVERLAY|seedMachineRecord|createAccountOnScreen/)
  assert.match(source, /stage\(scratch, release, \{ mode: STAGE_EXACT_RELEASE \}\)/)
  assert.match(source, /before === JSON\.stringify\(exactTreeManifest\(staged\.sourceRelease\)\)/)
})
