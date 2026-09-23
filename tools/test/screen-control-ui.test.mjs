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

test('Settings binds actual host grants, exclusive turns and visible stop', { timeout: 60000 }, async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'screen-controls-ui-'))
  const env = sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(dataRoot)))
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
    const { stdout } = await promisify(execFile)(require('electron'), [path.join(root, 'tools/test/helpers/screen-control-ui-electron.cjs'), dataRoot, `http://127.0.0.1:${server.httpServer.address().port}/__screen-control-fixture`], {
      cwd: root, env, windowsHide: true, timeout: 50000, maxBuffer: 2 * 1024 * 1024,
    })
    const result = stdout.split('\n').map(line => { try { return JSON.parse(line) } catch { return null } }).find(value => value?.ok)
    assert.ok(result, 'the production Settings view and native host must report the checked result')
    if (process.env.MC_SCREEN_CONTROL_EVIDENCE_DIR) {
      const target = path.resolve(process.env.MC_SCREEN_CONTROL_EVIDENCE_DIR)
      await mkdir(target, { recursive: true })
      await writeFile(path.join(target, 'screen-control-ui.json'), JSON.stringify(result, null, 2) + '\n')
    }
    console.log(JSON.stringify(result))
  } finally { await server.close() }
})
