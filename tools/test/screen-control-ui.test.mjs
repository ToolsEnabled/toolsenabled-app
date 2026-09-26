import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const { prepareSterileProfile, sterileProfileDirectories, sterileLaunchEnvironment } = require('../lib/sterile-launch.cjs')
import { nightlySkipReason } from '../lib/test-suite-result.mjs'

test('Settings binds actual host grants, exclusive turns and visible stop', { timeout: 180000 }, async t => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'screen-controls-ui-'))
  const env = sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(dataRoot)))
  if (process.platform === 'linux') {
    assert.ok(Buffer.byteLength(dataRoot, 'utf8') <= 60, 'the native proof needs a short private Unix socket directory')
    env.TMPDIR = dataRoot
  }
  const fixture = (request, response, next) => {
    if (request.url !== '/__screen-control-fixture') return next()
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end('<!doctype html><html><head><link rel="stylesheet" href="/src/styles.css"></head><body><script type="module">import("/src/views/settings.js").then(({settingsView})=>{ window.settingsFixture = settingsView({query:new URLSearchParams("category=app-permissions")}); document.body.append(window.settingsFixture.el); window.fixtureReady=true; }).catch(error=>window.fixtureError=String(error.stack||error));</script></body></html>')
  }
  const server = await createServer({ root, cacheDir: path.join(dataRoot, 'vite-cache'), configFile: false, logLevel: 'error',
    plugins: [{ name: 'screen-control-fixture', configureServer(server) { server.middlewares.use(fixture) } }],
    server: { host: '127.0.0.1', port: 0, watch: null, hmr: false }, optimizeDeps: { noDiscovery: true,
      include: ['markdown-it', 'highlight.js/lib/core', ...['javascript', 'typescript', 'python', 'bash', 'powershell', 'json', 'yaml', 'xml', 'css', 'sql', 'diff', 'rust', 'go', 'cpp', 'java', 'csharp'].map(name => 'highlight.js/lib/languages/' + name)] } })
  try {
    await server.listen()
    const phases = []
    for (const phase of ['exercise', 'restore', 'off']) {
      // URL and phase travel in the environment: see the helper's note on Windows
      // Electron dropping a URL argument that is followed by another argument.
      const { stdout } = await promisify(execFile)(require('electron'), [path.join(root, 'tools/test/helpers/screen-control-ui-electron.cjs'), dataRoot], {
        cwd: root, windowsHide: true, timeout: 55000, maxBuffer: 2 * 1024 * 1024,
        env: { ...env, MC_SCREEN_CONTROL_FIXTURE_URL: `http://127.0.0.1:${server.httpServer.address().port}/__screen-control-fixture`, MC_SCREEN_CONTROL_PHASE: phase },
      })
      const lines = stdout.split('\n').map(line => { try { return JSON.parse(line) } catch { return null } })
      // The helper stops before opening its 1200x900 windows when the desktop is
      // smaller than they are; that is a desktop to find, not Settings to judge.
      if (lines.some(value => value?.skipped === 'display')) return t.skip(nightlySkipReason('screen-control-ui-desktop'))
      const result = lines.find(value => value?.ok)
      assert.ok(result, `the actual Settings/host/store phase ${phase} must complete`)
      assert.equal(result.phase, phase)
      assert.equal(result.cleanupConfirmed, true)
      phases.push(result)
    }
    assert.equal(new Set(phases.map(result => result.pid)).size, 3, 'restart proof requires three distinct real Electron processes')
    assert.notEqual(phases[0].selectedSessionId, phases[1].selectedSessionId, 'restoration must not reuse the original live session identifier')
    assert.equal(phases[0].rememberedCount, 1)
    assert.equal(phases[1].rememberedCount, 0)
    assert.equal(phases[2].rememberedCount, 0)
    const result = { ok: true, dataRoot, phases, scope: 'Three real Electron processes, production Settings/host/permission store/native adapter, isolated fixture session identities; no provider or full-app saved-tree admission claim.' }
    if (process.env.MC_SCREEN_CONTROL_EVIDENCE_DIR) {
      const target = path.resolve(process.env.MC_SCREEN_CONTROL_EVIDENCE_DIR)
      await mkdir(target, { recursive: true })
      await writeFile(path.join(target, 'screen-control-ui.json'), JSON.stringify(result, null, 2) + '\n')
    }
    console.log(JSON.stringify(result))
  } finally { await server.close() }
})
