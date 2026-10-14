/* 1.0.49 VIDEO BOX: the capture permission gate in a real Electron (review F1).
 *
 * Electron 43 sends the permission handler the same request for the old
 * desktop getUserMedia ({chromeMediaSource: 'desktop'}) as for getDisplayMedia,
 * and the old path never reaches the display handler. This test runs the app's
 * real shell/video-box-host.cjs and shell/voice-permissions.cjs in Electron and
 * checks the three rules that close that door: no list of windows without the
 * person's click, one request per pick, and a reload when a grant went
 * elsewhere. It also checks the intended path still works twice in a row.
 *
 * Opt-in (MC_VIDEO_BOX_ELECTRON_TEST=1), Linux only, and always on a private X
 * server that xvfb-run starts: a capture on the person's own desktop would read
 * their screen. MC_VIDEO_BOX_XVFB_SERVER picks that server's number (for
 * example 93); otherwise xvfb-run picks a free one. Needs xvfb-run, xterm,
 * xwininfo and xprop.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
const { prepareSterileProfile, sterileProfileDirectories, sterileLaunchEnvironment } = require('../lib/sterile-launch.cjs')
const { GRANT_CHECK_MS } = require('../../shell/video-box-host.cjs')

const tools = ['xvfb-run', 'xterm', 'xwininfo', 'xprop']
const missing = process.platform === 'linux' ? tools.filter(name => spawnSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' }).status !== 0) : tools
const server = process.env.MC_VIDEO_BOX_XVFB_SERVER
const skip = process.env.MC_VIDEO_BOX_ELECTRON_TEST !== '1' ? 'opt-in: set MC_VIDEO_BOX_ELECTRON_TEST=1'
  : process.platform !== 'linux' ? 'Linux X11 only'
    : missing.length ? `needs ${missing.join(', ')}`
      : server !== undefined && !/^\d{1,4}$/.test(server) ? 'MC_VIDEO_BOX_XVFB_SERVER must be a display number' : false

test('the capture gate in Electron: a click to list, one request per pick, and a reload for a grant that went elsewhere', { skip, timeout: 90000 }, async t => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'video-box-electron-'))
  t.after(() => rm(dataRoot, { recursive: true, force: true }))
  const env = sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(dataRoot)))
  env.XDG_SESSION_TYPE = 'x11'
  delete env.WAYLAND_DISPLAY
  env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=' + path.join(dataRoot, 'no-dbus')
  const args = [...(server ? ['-n', server] : ['-a']), '-s', '-screen 0 1280x800x24 -nolisten tcp',
    require('electron'), path.join(root, 'tools/test/helpers/video-box-electron.cjs'), dataRoot]
  const { stdout } = await promisify(execFile)('/usr/bin/xvfb-run', args, { cwd: root, env, timeout: 80000, maxBuffer: 1024 * 1024 })
  const result = stdout.split('\n').map(line => { try { return JSON.parse(line) } catch { return null } }).find(value => value && 'done' in value)
  assert.equal(result?.done, true, 'the Electron run finished')
  const steps = result.steps
  t.diagnostic(JSON.stringify(steps))
  assert.equal(steps.sourceShown, true, 'the window to pick was shown')
  // No list of windows (and no thumbnails) without the person's click.
  assert.deepEqual(steps.listWithoutClick, { ok: false, code: 'VIDEO_NEEDS_CLICK' })
  assert.equal(steps.listWithClick.ok, true)
  assert.equal(steps.listWithClick.names.includes('VIDEO-BOX-SOURCE'), true)
  assert.equal(steps.listWithClick.names.includes('VIDEO-BOX-APP'), false, 'never the app’s own window')
  // The old desktop capture through the same gate: one at most, then the page reloads.
  assert.deepEqual(steps.legacy.armed, { ok: true })
  assert.equal(steps.legacy.second.ok, false, 'a second request on one pick is refused')
  if (steps.legacy.first.ok) {
    assert.equal(steps.strayReloads, 1, 'a grant the display handler never took reloads the page')
    assert.ok(steps.strayReloadAfterMs >= GRANT_CHECK_MS && steps.strayReloadAfterMs < GRANT_CHECK_MS + 3000, String(steps.strayReloadAfterMs))
    assert.equal(steps.navigatedAfterLegacy >= 1, true)
    assert.equal(steps.markAfterLegacy, 'undefined', 'the page that held the capture is gone')
    if (steps.legacyThreadsWhileLive > steps.baselineThreads) assert.equal(steps.threadsAfterReload, steps.baselineThreads, 'the capture ended')
  }
  // The check waits far longer than Electron takes to call the display handler.
  assert.equal(steps.grantToDisplayHandlerMs.length, 3)
  assert.equal(steps.grantToDisplayHandlerMs.every(ms => ms < GRANT_CHECK_MS / 5), true, JSON.stringify(steps.grantToDisplayHandlerMs))
  // The intended path still works, twice in a row, and nothing reloads.
  assert.deepEqual(steps.displayFirst, { armed: { ok: true }, first: { ok: true, label: 'VIDEO-BOX-SOURCE', state: 'live' } })
  assert.deepEqual(steps.displaySecond, { armed: { ok: true }, first: { ok: true, label: 'VIDEO-BOX-SOURCE', state: 'live' } })
  assert.equal(steps.intendedReloads, 0)
  assert.equal(steps.navigatedAfterIntended, 0)
  assert.equal(steps.markAfterIntended, 'intended')
  assert.deepEqual(steps.liveAfterIntended, ['live', 'live'])
  // One pick, one stream.
  assert.equal(steps.onePickTwoRequests.first.ok, true)
  assert.equal(steps.onePickTwoRequests.second.ok, false)
  assert.equal(steps.reloadsAtEnd, steps.strayReloads, 'a refused second request reloads nothing')
})
