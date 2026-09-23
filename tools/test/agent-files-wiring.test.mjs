/* THE FIVE VERBS ARE ACTUALLY WIRED, END TO END, NOT ASSERTED.
 *
 * This repository has been bitten three times by a bridge that was built,
 * tested and mounted on the preload NO WINDOW LOADS -- see the header of
 * tools/test/preload-namespace-parity.test.mjs, where the third one cost a
 * whole feature that rendered its honest "this needs the app" state forever on
 * the app. Every renderer call site feature-detects, so the failure is silent:
 * a person presses a button and nothing happens.
 *
 * So this suite refuses to take any part of the chain on trust.
 *
 *   1. It EXECUTES shell/fleet-profile-preload.cjs -- the preload main.cjs
 *      actually hands to its window, read out of main.cjs rather than named
 *      here -- with Electron's two objects stubbed, and reads which channels
 *      the mcFiles bridge invokes.
 *   2. It wires that stub straight into the REAL shell/agent-files.cjs over a
 *      REAL folder with a REAL payload staged on disk, so calling
 *      window.mcFiles.open(...) ends with a path arriving at the recorder that
 *      stands in for shell.openPath. The argument shapes are therefore proven
 *      to match, rather than looking as though they do.
 *   3. It reads shell/main.cjs and requires every channel the bridge speaks to
 *      be registered there, behind the sender check, forwarded to the surface
 *      -- and requires the reverse too, so a handler added with no bridge, or a
 *      bridge with no handler, fails here.
 *
 * WHAT IT CANNOT SEE: Electron's own IPC transport, and the real openPath. No
 * Electron process is started by this suite.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import Module, { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const require_ = createRequire(import.meta.url)
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const MAIN_SOURCE = readFileSync(path.join(REPO, 'shell', 'main.cjs'), 'utf8')

const { createAgentFileSurface, BOUNDARY_MODULE } = require_(path.join(REPO, 'shell', 'agent-files.cjs'))
const { resolveCapabilityRoot } = require_(path.join(REPO, 'shell', 'capability-layer.cjs'))
const FENCE_FIXTURE = path.join(REPO, 'tools', 'test', 'fixtures', 'workspace-fence', BOUNDARY_MODULE)

/* The preload main.cjs hands to its window. Read, never assumed -- the same
   rule tools/test/preload-namespace-parity.test.mjs applies. */
function loadedPreloadFile() {
  const withoutComments = MAIN_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const match = /preload:\s*path\.join\([^)]*?['"]([\w.-]+\.cjs)['"]\s*\)/.exec(withoutComments)
  assert.ok(match, 'could not find the preload main.cjs loads')
  return path.join(REPO, 'shell', match[1])
}

/* A payload with the real fence in it, and a folder with a real file. */
function stage() {
  const resources = mkdtempSync(path.join(tmpdir(), 'mc-files-wire-'))
  const payload = path.join(resources, 'capability')
  mkdirSync(path.join(payload, 'src', 'lib'), { recursive: true })
  writeFileSync(path.join(payload, 'PAYLOAD.json'), JSON.stringify({ bridgeEntrypoint: 'tools/mission-bridge.js' }))
  writeFileSync(path.join(payload, 'package.json'), JSON.stringify({ name: 'payload', private: true, type: 'commonjs' }))
  copyFileSync(FENCE_FIXTURE, path.join(payload, ...BOUNDARY_MODULE.split('/')))

  const folder = path.join(resources, 'work')
  mkdirSync(folder, { recursive: true })
  writeFileSync(path.join(folder, 'REPORT-the-run.md'), '# What I did\n')
  writeFileSync(path.join(folder, 'invoice.pdf'), '%PDF-1.7')
  /* A file of the kind that made this whole surface dangerous, put in the
     folder the same way an agent would put it there. */
  writeFileSync(path.join(folder, 'cleanup.bat'), 'del /q *.*\n')
  return { resources, folder }
}

/**
 * Execute the loaded preload with Electron stubbed, and route every invoke to
 * the real main-process surface. The result is the window's own bridge object
 * sitting on top of the real code.
 */
function bridgeOverRealSurface() {
  const { resources, folder } = stage()
  const opened = []
  const revealed = []
  const surface = createAgentFileSurface({
    resolveCapabilityRoot: () => resolveCapabilityRoot({ resourcesPath: resources, repoRoot: resources }),
    requireModule: require_,
    readWorkspaceState: () => ({ ok: true, available: true, roots: [folder] }),
    listSessionProfiles: () => [],
    openPath: async (target) => { opened.push(target); return '' },
    showItemInFolder: (target) => { revealed.push(target) },
  })
  /* The handler table main.cjs registers, built the way main.cjs builds it. The
     source check below is what proves main.cjs really registers these. */
  const handlers = {
    'mc-files:folders': () => surface.folders(),
    'mc-files:list': request => surface.list(request),
    'mc-files:open': request => surface.open(request),
    'mc-files:reveal': request => surface.reveal(request),
    'mc-files:read': request => surface.read(request),
  }

  const preload = loadedPreloadFile()
  const exposed = new Map()
  const channels = []
  const ipcRenderer = {
    sendSync(channel) {
      if (channel === 'mc-fleet-profile:bootstrap') return { ok: true, profile: { name: 'Home fleet' } }
      return { ok: false, code: 'NOT_AVAILABLE' }
    },
    invoke(channel, ...args) {
      channels.push(channel)
      const handler = handlers[channel]
      if (!handler) return Promise.resolve({ ok: true })
      return Promise.resolve(handler(...args))
    },
    on() {}, removeListener() {}, send() {},
  }
  const electron = { contextBridge: { exposeInMainWorld: (name, value) => exposed.set(name, value) }, ipcRenderer }
  const originalLoad = Module._load
  const originalWindow = globalThis.window
  Module._load = function (request, parent, isMain) {
    if (request === 'electron' && parent?.filename === preload) return electron
    return originalLoad.call(this, request, parent, isMain)
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { addEventListener() {} } })
  try {
    delete require_.cache[preload]
    require_(preload)
  } finally {
    Module._load = originalLoad
    if (originalWindow === undefined) delete globalThis.window
    else Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: originalWindow })
  }
  return { bridge: exposed.get('mcFiles'), channels, opened, revealed, folder }
}

test('the preload the app loads exposes the file bridge', () => {
  const { bridge } = bridgeOverRealSurface()
  assert.ok(bridge, 'window.mcFiles is undefined on the preload main.cjs actually loads')
  assert.deepEqual(Object.keys(bridge).sort(), ['folders', 'list', 'open', 'read', 'reveal'])
  assert.ok(Object.isFrozen(bridge))
})

test('a press on the bridge reaches the operating system hand-off, with the right path', async () => {
  const { bridge, opened, revealed, folder } = bridgeOverRealSurface()

  const folders = await bridge.folders()
  assert.deepEqual(folders.folders.map(entry => entry.id), ['chosen-0'])

  const listed = await bridge.list({ folderId: 'chosen-0' })
  assert.deepEqual(listed.files.map(file => file.name).sort(),
    ['REPORT-the-run.md', 'cleanup.bat', 'invoice.pdf'])

  assert.deepEqual(await bridge.open({ folderId: 'chosen-0', name: 'invoice.pdf' }),
    { ok: true, name: 'invoice.pdf' })
  assert.deepEqual(opened, [path.join(folder, 'invoice.pdf')],
    'the bridge argument shape and the surface argument shape must be the same shape')

  assert.deepEqual(await bridge.reveal({ folderId: 'chosen-0', name: 'invoice.pdf' }),
    { ok: true, name: 'invoice.pdf' })
  assert.deepEqual(revealed, [path.join(folder, 'invoice.pdf')])

  const report = await bridge.read({ folderId: 'chosen-0', name: 'REPORT-the-run.md' })
  assert.equal(report.text, '# What I did\n')
})

test('the fence is in the chain: a name that leaves the folder never reaches the hand-off', async () => {
  const { bridge, opened } = bridgeOverRealSurface()
  for (const name of ['..\\..\\Windows\\System32\\calc.exe', '../invoice.pdf', 'C:\\Windows\\notepad.exe']) {
    const reply = await bridge.open({ folderId: 'chosen-0', name })
    assert.equal(reply.ok, false)
  }
  assert.deepEqual(opened, [])
})

test('and so is the kind rule: a file that can run never reaches the hand-off either', async () => {
  /* THE SECOND QUESTION, THROUGH THE WHOLE CHAIN. `cleanup.bat` is exactly
     where the person's own files are, so the fence says yes to it; the reply
     the window gets still refuses, and the row it drew says so before anybody
     presses anything. Both halves have to survive the bridge, because the
     bridge is where a shape mismatch would quietly drop one. */
  const { bridge, opened, revealed, folder } = bridgeOverRealSurface()

  const listed = await bridge.list({ folderId: 'chosen-0' })
  const row = listed.files.find(file => file.name === 'cleanup.bat')
  assert.equal(row.openable, false, 'the row must arrive at the window already knowing')
  assert.equal(row.readable, true, 'and it must still be readable in the window that will not run it')

  const reply = await bridge.open({ folderId: 'chosen-0', name: 'cleanup.bat' })
  assert.equal(reply.ok, false)
  assert.equal(reply.code, 'FILES_NOT_OPENABLE')
  assert.deepEqual(opened, [])

  /* And the way out of it works through the same chain. */
  assert.equal((await bridge.reveal({ folderId: 'chosen-0', name: 'cleanup.bat' })).ok, true)
  assert.deepEqual(revealed, [path.join(folder, 'cleanup.bat')])
  assert.equal((await bridge.read({ folderId: 'chosen-0', name: 'cleanup.bat' })).text, 'del /q *.*\n')
})

/* ---------- and main.cjs really registers them ---------- */

function registeredFileChannels() {
  return [...MAIN_SOURCE.matchAll(/ipcMain\.handle\('(mc-files:[a-z-]+)'/g)].map(match => ({
    channel: match[1], at: match.index,
  }))
}

test('every channel the bridge speaks is registered in main.cjs, and every one registered is spoken', () => {
  const { bridge, channels } = bridgeOverRealSurface()
  for (const key of Object.keys(bridge)) bridge[key]({ folderId: 'chosen-0', name: 'invoice.pdf' })
  const spoken = new Set(channels.filter(channel => channel.startsWith('mc-files:')))
  const registered = new Set(registeredFileChannels().map(entry => entry.channel))
  assert.ok(spoken.size >= 5, 'the bridge spoke fewer channels than it has verbs')
  assert.deepEqual([...spoken].sort(), [...registered].sort(),
    'the preload and main.cjs disagree about which file channels exist. '
    + 'A channel on one side only is a control that silently does nothing.')
})

test('every file channel checks the sender before it touches a path', () => {
  const entries = registeredFileChannels()
  assert.equal(entries.length, 5)
  for (const [index, { channel, at }] of entries.entries()) {
    /* THIS HANDLER'S BODY AND NOT ITS NEIGHBOUR'S, bounded at its own closing
       brace. A fixed-width window past the registration reaches into the NEXT
       `ipcMain.handle`, and a sender check found there says nothing about this
       one -- measured: deleting the check from mc-files:open left this test
       green until the window was closed here. */
    const end = MAIN_SOURCE.indexOf('\n})', at)
    assert.ok(end > at, `the body of ${channel} could not be found; this test is broken, not the shell`)
    const body = MAIN_SOURCE.slice(at, end)
    assert.ok(body.length < 400, `${channel} has an unexpectedly long body; this test is reading the wrong thing`)
    assert.equal(index >= 0, true)
    assert.match(body, /assertTrustedAgentSender\(event\)/,
      `${channel} does not check the sender. openPath starts a program with the person's own rights; `
      + 'any frame that happens to be loaded must not be able to ask for that.')
    assert.match(body, /getAgentFileSurface\(\)\.(folders|list|open|reveal|read)\(/,
      `${channel} does not forward to the file surface`)
  }
})

test('main.cjs holds no second copy of the fence', () => {
  /* The one place a path is judged is shell/agent-files.cjs, which asks the
     payload's own workspace boundary. A `startsWith`, a `path.relative` or a
     `resolve`-and-compare growing in the wiring block would be the second
     boundary this design exists to avoid -- and the weaker of two boundaries is
     always the one that admits something. */
  const from = MAIN_SOURCE.indexOf('---------- the files an agent left behind')
  const to = MAIN_SOURCE.indexOf('---------- the product account', from)
  assert.ok(from !== -1 && to > from, 'the file wiring block could not be found; this test is broken, not the shell')
  const wiring = MAIN_SOURCE.slice(from, to)
  assert.match(wiring, /ipcMain\.handle\('mc-files:/, 'the block found is not the wiring block')
  for (const shape of [/\.startsWith\(/, /path\.relative\(/, /realpathSync/, /\.\.['"]/]) {
    assert.doesNotMatch(wiring, shape,
      'the file wiring in main.cjs is judging a path itself. The fence is the payload boundary, asked once, in shell/agent-files.cjs.')
  }
})
