import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { parseAst } from 'rollup/parseAst'
import ownerModule from '../../shell/owner-administration.cjs'
const source = fs.readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
const statements = parseAst(source).body
function initializer(name) {
  const declaration = statements.flatMap(statement => statement.type === 'VariableDeclaration' ? statement.declarations : [])
    .find(declaration => declaration.id.name === name)
  assert.ok(declaration)
  return source.slice(declaration.init.start, declaration.init.end)
}
test('actual main administration wiring supplies dynamic current consent and shutdown predicates', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'te-admin-wiring-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let dependencies
  const context = { createOwnerAdministration(options) { dependencies = options; return ownerModule.createOwnerAdministration(options) },
    SHELL_USER_DATA_PATH: root, CAPABILITY_STATE_ROOT: path.join(root, 'capability'), remoteConnection: { administer() {} },
    rendererPrefs: { on: false }, webDriveMayWrite: prefs => prefs.on, appShutdown: { started: false },
    agentRuntimeStoppedForReset: false, remoteAccessStopping: false }
  runInNewContext(initializer('ownerAdministration'), context)
  assert.equal(dependencies.webDriveEnabled(), false)
  context.rendererPrefs.on = true
  assert.equal(dependencies.webDriveEnabled(), true)
  assert.equal(dependencies.available(), true)
  context.appShutdown.started = true
  assert.equal(dependencies.available(), false)
})
test('actual IPC guards the existing local sender and forwards only the fixed action', async () => {
  const statement = statements.find(statement => source.slice(statement.start, statement.end).startsWith("ipcMain.handle('mc-device-admin:run'"))
  assert.ok(statement)
  let handler
  const event = {}
  let guarded = false
  const context = { ipcMain: { handle(channel, callback) { assert.equal(channel, 'mc-device-admin:run'); handler = callback } },
    assertTrustedAgentSender(value) { assert.equal(value, event); guarded = true },
    ownerAdministration: { run(action) { assert.equal(guarded, true); return action } } }
  runInNewContext(source.slice(statement.start, statement.end), context)
  assert.equal(await handler(event, 'prepare', { malicious: 'ignored' }), 'prepare')
  context.assertTrustedAgentSender = () => { throw Error('refused origin') }
  assert.throws(() => handler({}, 'prepare'))
})
test('packed closure explicitly includes the administrative CLI and keeps public-auth entrypoint separate', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../capability-manifest.json', import.meta.url)))
  const boundary = JSON.parse(fs.readFileSync(new URL('../../config/payload-boundary.json', import.meta.url)))
  assert(manifest.spawnedPrograms.includes('tools/online-fra-admin-cli.js'))
  assert(manifest.spawnedPrograms.includes('tools/online-fra-claim-cli.js'))
  assert(boundary.open.paths.includes('tools/online-fra-admin-cli.js'))
})
