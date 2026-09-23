/* THE FENCE AROUND THE PACKAGED SMOKE RUN, AND THE HOMES THE WINDOW IS GIVEN.
 *
 * THE DEFECT, MEASURED 2026-08-22 (twice, then once more from the next launcher
 * in the chain): the packaged smoke run -- a fresh --user-data-dir, the
 * builder's own environment -- rewrote the builder's workspace `.mcp.json` to
 * point its three servers at release-cut\win-unpacked. The machine record the
 * shell reads lives in %LOCALAPPDATA%\ToolsEnabled, not in the Electron
 * profile, so the "fresh" window read the builder's record, found the workspace
 * it named, and repointed the document there at itself (shell/setup-record.cjs
 * refreshChosenAssistantConfig, from shell/main.cjs on every launch).
 *
 * TWO THINGS ARE PINNED HERE, AND THEY ARE NOT THE SAME THING. The redirect --
 * main() gives the window LOCALAPPDATA, APPDATA, USERPROFILE, CODEX_HOME and
 * TEMP inside the smoke profile, through the one shared helper in
 * tools/lib/sterile-launch.cjs -- is how the run stays out of the builder's
 * files. The fence -- runAll() snapshots the files a launch with the INHERITED
 * environment would have targeted and refuses the smoke if any of them changed
 * -- is the proof that it did. A redirect can regress silently; a fence cannot
 * pass over a rewritten file. The helper and the fence themselves are pinned in
 * tools/test/sterile-launch.test.mjs; this file pins how the smoke USES them.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import { APP_EXE, APP_MARKER, main, runAll, smokeGuiEnvironment } from '../smoke-packaged.mjs'

const require_ = createRequire(import.meta.url)
const { createOutsideWriteFence, sterileProfileDirectories, shortLinuxTmpdir } = require_('../lib/sterile-launch.cjs')

async function temporaryTree(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'smoke-fence-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10 }))
  return root
}

async function exists(file) {
  try { await access(file); return true } catch { return false }
}

/* A builder's machine in miniature: a LOCALAPPDATA holding a machine record
   that names a workspace root holding the builder's own agent configuration. */
async function builderMachine(root) {
  const localAppData = path.join(root, 'local')
  const userProfile = path.join(root, 'home')
  const desktop = path.join(root, 'Desktop')
  await mkdir(path.join(localAppData, 'ToolsEnabled'), { recursive: true })
  await mkdir(desktop, { recursive: true })
  await mkdir(userProfile, { recursive: true })
  await writeFile(path.join(localAppData, 'ToolsEnabled', 'machine.json'), JSON.stringify({ schemaVersion: 1, workspaceRoots: [desktop] }))
  const mine = '{"mcpServers":{"mine":{"command":"node","args":["mine.js"]}}}\n'
  await writeFile(path.join(desktop, '.mcp.json'), mine)
  return { env: { LOCALAPPDATA: localAppData, USERPROFILE: userProfile }, desktop, mine }
}

/* ------------------------------------------------------- runAll, fenced -- */

test('F7 - runAll refuses a run whose halves both passed when a fenced file changed', async (t) => {
  const root = await temporaryTree(t)
  const m = await builderMachine(root)
  const desktopConfig = path.join(m.desktop, '.mcp.json')
  const fence = createOutsideWriteFence({ env: m.env, cwd: null, appDirectory: null, label: 'the packaged smoke run' })

  await assert.rejects(
    runAll('anywhere', {
      outsideWriteFence: fence,
      main: async () => {
        /* The window "passes" -- and on its way, does what the measured build did. */
        await writeFile(desktopConfig, '{"mcpServers":{"toolsenabled":{"command":"the build under test"}}}\n')
        return { port: 4601 }
      },
      assertCapabilityRoundTrip: async () => ({ tool: 'system.status' }),
    }),
    (error) => {
      assert.match(error.message, /the packaged smoke run changed 1 file\(s\) OUTSIDE its sterile profile/)
      assert.ok(error.message.toLowerCase().includes(desktopConfig.toLowerCase()))
      return true
    },
  )
})

test('F8 - runAll passes a clean run and returns both halves', async (t) => {
  const root = await temporaryTree(t)
  const m = await builderMachine(root)
  const result = await runAll('anywhere', {
    outsideWriteFence: createOutsideWriteFence({ env: m.env, cwd: null, appDirectory: null }),
    main: async () => ({ port: 4601 }),
    assertCapabilityRoundTrip: async () => ({ tool: 'system.status' }),
  })
  assert.equal(result.window.port, 4601)
  assert.equal(result.capability.tool, 'system.status')
})

test('F9 - a half that fails keeps its own message first, with the fence finding behind it', async (t) => {
  const root = await temporaryTree(t)
  const m = await builderMachine(root)
  const desktopConfig = path.join(m.desktop, '.mcp.json')
  await assert.rejects(
    runAll('anywhere', {
      outsideWriteFence: createOutsideWriteFence({ env: m.env, cwd: null, appDirectory: null }),
      main: async () => {
        await writeFile(desktopConfig, 'rewritten and then the window died\n')
        throw new Error('Packaged application exited before binding')
      },
      assertCapabilityRoundTrip: async () => { throw new Error('must not be reached') },
    }),
    (error) => {
      assert.ok(error.message.startsWith('Packaged application exited before binding'), error.message)
      assert.match(error.message, /OUTSIDE its sterile profile/)
      return true
    },
  )
})

test('F10 - the fence is armed by default and watches this computer only when nothing is injected', async () => {
  /* The CLI path passes no fence, so the real one is built from the real
     environment. Asserted only in shape: the default fence exists and has the
     two verbs runAll calls. Nothing here reads or writes a real file beyond
     what snapshotting (read-only) does. */
  const fence = createOutsideWriteFence({ appDirectory: path.resolve('release/win-unpacked') })
  assert.equal(typeof fence.arm, 'function')
  assert.equal(typeof fence.check, 'function')
  assert.ok(Array.isArray(fence.targets) && fence.targets.length >= 3)
})

/* ---------------------------------------------------- the window's homes -- */

function fakeChild(pid = 4242) {
  const child = new EventEmitter()
  child.pid = pid
  child.exitCode = null
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => true
  return child
}

test('F11 - the window is launched with every home inside the smoke profile, and the Electron profile stays where it was', async (t) => {
  const directory = await temporaryTree(t)
  await writeFile(path.join(directory, APP_EXE), 'test placeholder')
  const profile = path.join(directory, 'smoke-profile')
  let spawnArguments
  let spawnOptions

  await main(directory, {
    spawn: (_executable, arguments_, options) => {
      spawnArguments = arguments_
      spawnOptions = options
      return fakeChild()
    },
    fetch: async () => ({ status: 200, text: async () => APP_MARKER }),
    findExistingInstances: async () => [],
    getWindowTitle: async () => '',
    terminateProcessTree: async () => {},
    makeSmokeProfileDirectory: async () => profile,
    removeSmokeProfileDirectory: async () => {},
    timeoutMs: 100,
    pollIntervalMs: 1,
    log: () => {},
  })

  const expected = sterileProfileDirectories(profile)
  assert.equal(spawnArguments[0], `--user-data-dir=${profile}`, 'the Electron profile argument must not move')
  assert.equal(spawnOptions.env.LOCALAPPDATA, expected.localAppData)
  assert.equal(spawnOptions.env.APPDATA, expected.appData)
  assert.equal(spawnOptions.env.USERPROFILE, expected.userProfile)
  assert.equal(spawnOptions.env.CODEX_HOME, expected.codexHome)
  assert.equal(spawnOptions.env.TEMP, expected.temp)
  assert.equal(spawnOptions.env.TMP, expected.temp)
  for (const variable of ['LOCALAPPDATA', 'APPDATA', 'USERPROFILE']) {
    assert.notEqual(spawnOptions.env[variable], process.env[variable], `${variable} must NOT be inherited: the builder's machine record is exactly what a customer will not have`)
  }
  for (const gone of ['HOMEDRIVE', 'HOMEPATH', 'CLAUDE_CONFIG_DIR', ...(process.platform === 'linux' ? [] : ['HOME'])]) {
    assert.equal(gone in spawnOptions.env, false, `${gone} must not name the builder's home`)
  }
  if (process.platform === 'linux') {
    assert.equal(spawnOptions.env.HOME, expected.userProfile, 'omitting HOME would expose the passwd account home')
    assert.notEqual(spawnOptions.env.HOME, process.env.HOME)
    assert.equal(spawnOptions.env.XDG_CONFIG_HOME, expected.appData)
    assert.equal(spawnOptions.env.XDG_DATA_HOME, expected.localAppData)
    assert.equal(spawnOptions.env.XDG_CACHE_HOME, path.join(expected.localAppData, 'cache'))
    assert.equal(spawnOptions.env.TMPDIR, shortLinuxTmpdir(), 'Chromium needs a short socket path even under a deep smoke profile')
  }
  assert.equal(spawnOptions.env.MC_SMOKE_HEADLESS, '1', 'no window on the builder\'s desktop is this gate\'s own choice, stated after the helper')
  assert.equal('ELECTRON_RUN_AS_NODE' in spawnOptions.env, false)
  /* The homes exist before the spawn, because Chromium wants a TEMP it can write. */
  for (const home of Object.values(expected)) assert.ok(await exists(home), `${home} was not created before the spawn`)
})

test('F12 - the packaged GUI receives a system-only PATH even when the cut wrapper prepends a build tool', () => {
  const profile = sterileProfileDirectories(path.join(tmpdir(), 'smoke-path-fixture'))
  const environment = smokeGuiEnvironment(profile, {
    PATH: 'C:\\agent-apps\\node-v22.19.0;C:\\Windows\\System32',
    Path: 'C:\\other-build-tool',
    SystemRoot: 'C:\\Windows',
  })

  if (process.platform === 'linux') {
    assert.equal(environment.PATH, '/usr/bin:/bin')
    assert.equal('Path' in environment, false, 'no inherited alternate PATH spelling')
  } else {
    assert.equal('PATH' in environment, false, 'Windows must not receive a second inherited PATH spelling')
    assert.equal(environment.Path, [
      'C:\\Windows\\System32',
      'C:\\Windows',
      'C:\\Windows\\System32\\Wbem',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
    ].join(';'))
  }
  const searchPath = environment.PATH ?? environment.Path
  assert.equal(searchPath.includes('agent-apps'), false)
  assert.equal(searchPath.includes('other-build-tool'), false)
  assert.equal(environment.MC_SMOKE_HEADLESS, '1')
})
