import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { canonicalRootForTests } from '../canonical-root.mjs'
import capabilityLayer from '../../shell/capability-layer.cjs'

const require = createRequire(import.meta.url)
const engineRoot = canonicalRootForTests()
const retention = require(path.join(engineRoot, 'src/lib/diagnostic-retention.js'))
const { createProductDiagnostics } = require('../../shell/product-settings.cjs')

test('the actual app startup passes cleanup receipts into its visible managed diagnostics', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-signin-app-'))
  t.after(() => fs.rmSync(root, { force: true, recursive: true }))
  const services = path.join(root, 'services')
  const file = path.join(services, 'agent-home', '@agents', 'worker-one', '@sessions',
    'a'.repeat(64), 'codex', 'standard', '@default', 'auth.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, 'synthetic fixture')
  const store = retention.createDiagnosticStore({ directory: path.join(root, 'diagnostics'),
    readPolicy: () => retention.resolveDiagnosticPolicy() })
  const productDiagnostics = createProductDiagnostics({ store, retentionModule: retention })
  t.after(() => productDiagnostics.dispose())
  // Use the real main-process writer declaration, not a parallel test wiring.
  const main = fs.readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
  const beginning = main.indexOf('const productDiagnostics =')
  const ending = main.indexOf('// Only new managed files', beginning)
  const declaration = main.slice(beginning, ending)
  const writers = []
  const bindings = { createProductDiagnostics: () => ({
    writer(kind) { const writer = productDiagnostics.writer(kind); writers.push(writer); return writer },
  }), dialog: {}, validateTranscriptDirectory() {} }
  const context = vm.createContext(bindings)
  vm.runInContext(declaration, context)

  const payload = path.join(root, 'payload')
  fs.mkdirSync(path.join(payload, 'src'), { recursive: true })
  fs.writeFileSync(path.join(payload, 'PAYLOAD.json'), JSON.stringify({
    bridgeEntrypoint: 'bridge.cjs', ownerHostModule: 'src/owner-host.js', hostModules: ['src/owner-host.js'],
  }))
  fs.writeFileSync(path.join(payload, 'bridge.cjs'), '')
  fs.writeFileSync(path.join(payload, 'src/owner-host.js'), [
    'exports.createOwnerHost = options => ({',
    'listen() { return require(' + JSON.stringify(path.join(engineRoot, 'src/lib/legacy-signin-cleanup.js')) + ').cleanupLegacySignIns({',
    'servicesRoot: ' + JSON.stringify(services) + ', observe: options.onLegacySignInCleanup }); },',
    'close() {}, bindSession() {}, revokeSession() {}, assertSession() {} })',
  ].join('\n'))
  const start = main.indexOf('const ownerHostStarted = await startAppOwnedOwnerHost({')
  const end = main.indexOf('\n    })', start) + '\n    })'.length
  assert.ok(start >= 0 && end > start)
  Object.assign(bindings, { root: payload, startAppOwnedOwnerHost: capabilityLayer.startAppOwnedOwnerHost,
    getTaskLedgerAssignmentWriter() {}, mainLagMonitor: null })
  const result = await vm.runInContext('(async () => {' + main.slice(start, end) + '; return ownerHostStarted })()', context)
  assert.equal(result.ok, true)
  assert.equal(fs.existsSync(file), false)
  for (const writer of writers) writer.close()
  const inspected = await productDiagnostics.inspect()
  assert.equal(inspected.ok, true)
  const entry = inspected.files.find(row => row.kind === 'legacy-signin-cleanup')
  assert.ok(entry, 'Settings diagnostics can enumerate the cleanup record')
  const text = fs.readFileSync(path.join(root, 'diagnostics', entry.id), 'utf8')
  const rows = text.trim().split('\n').map(JSON.parse)
  assert.equal(rows.filter(row => row.event === 'removed').length, 1)
  assert.ok(rows.some(row => row.event === 'summary' && row.removedCount === 1 && /Removed 1 legacy provider sign-in file/.test(row.sentence)))
  assert.equal(text.includes('synthetic fixture'), false)
})


test('app-owned startup keeps main-process timers responsive while awaiting cleanup', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-async-app-'))
  t.after(() => fs.rmSync(root, { force: true, recursive: true }))
  const services = path.join(root, 'services')
  const file = path.join(services, 'agent-home', '@agents', 'worker-one', '@sessions',
    'a'.repeat(64), 'codex', 'standard', '@default', 'auth.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, 'synthetic fixture')
  const script = path.join(root, 'slow-helper.cjs')
  fs.writeFileSync(script, [
    "setTimeout(() => {",
    "require('node:fs').unlinkSync(" + JSON.stringify(file) + ");",
    "console.log(JSON.stringify({event:'removed',path:" + JSON.stringify(path.relative(services, file)) + "}));",
    "console.log(JSON.stringify({event:'complete'}));",
    "}, 200);",
  ].join('\n'))
  const payload = path.join(root, 'payload')
  fs.mkdirSync(path.join(payload, 'src'), { recursive: true })
  fs.writeFileSync(path.join(payload, 'PAYLOAD.json'), JSON.stringify({
    bridgeEntrypoint: 'bridge.cjs', ownerHostModule: 'src/owner-host.js', hostModules: ['src/owner-host.js'],
  }))
  fs.writeFileSync(path.join(payload, 'bridge.cjs'), '')
  fs.writeFileSync(path.join(payload, 'src/owner-host.js'), [
    'exports.createOwnerHost = options => ({',
    'listen() { return require(' + JSON.stringify(path.join(engineRoot, 'src/lib/legacy-signin-cleanup.js')) + ').cleanupLegacySignIns({',
    'servicesRoot: ' + JSON.stringify(services) + ', platform: "win32", environment: {SystemRoot: "\x43:\\\\Windows"},',
    'spawnImpl(executable,args,spawnOptions) { return require("node:child_process").spawn(process.execPath, [' + JSON.stringify(script) + '], spawnOptions); },',
    'observe: options.onLegacySignInCleanup }); },',
    'close() {}, bindSession() {}, revokeSession() {}, assertSession() {} })',
  ].join('\n'))
  const receipts = []
  let settled = false
  const startup = capabilityLayer.startAppOwnedOwnerHost({ root: payload,
    onLegacySignInCleanup: row => receipts.push(row) }).then(result => { settled = true; return result })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(settled, false, 'app authority must wait for the slow cleanup')
  assert.equal(fs.existsSync(file), true, 'timer must fire before cleanup has removed the fixture')
  const result = await startup
  assert.equal(result.ok, true)
  assert.equal(fs.existsSync(file), false)
  assert.ok(receipts.some(row => row.event === 'summary' && row.complete === true))
})
