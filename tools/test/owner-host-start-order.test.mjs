/* THE OWNER HOST STARTS THE WAY shell/main.cjs STARTS IT, WITH AND WITHOUT A PLUGIN.
 *
 * WHAT THIS CAUGHT. At the first 1.0.49 integration (app 53f779dfc, engine
 * 850f3ae) the app's owner host did not start on a machine with NO plugin
 * installed. main.cjs builds its organisation record at load, and the payload's
 * custom-role store requires src/lib/tool-registry.js to describe role
 * functions; the owner host, much later, requires src/mcp-server.js, whose
 * plugin activation refused because the registry was already built. The app
 * printed `[owner-host] not started: OWNER_HOST_START_FAILED` and ran with no
 * agent-session authority. Every suite was green, because nothing started the
 * owner host in main.cjs's order.
 *
 * The engine now refuses only when a granted plugin's tools would be lost, and
 * main.cjs brings plugins up before anything in its process loads the registry
 * (activatePayloadPlugins() in shell/capability-layer.cjs), so a granted
 * plugin's tools reach the in-process MCP server and its roles reach the
 * organisation record.
 *
 * HOW. Each start runs in a fresh process (tools/test/helpers/
 * owner-host-start-order.cjs): activation and the registry are once per
 * process. The steps are main.cjs's own module-scope steps, in the order they
 * appear in main.cjs, then the owner host, which main.cjs starts from
 * createWindow() after load -- READ FROM main.cjs, so moving those lines moves
 * this test with them rather than leaving it to prove an order the app no
 * longer has. The grant is written the way Save on #/plugins writes it, through
 * shell/plugin-catalogue.cjs.
 *
 * Red at app 53f779dfc: with its payload (engine 850f3ae) all three tests fail
 * (the owner host does not start even with no plugin); with the engine fix
 * packed under it, the no-plugin start passes and the granted start still
 * fails, because the organisation record has loaded the registry first. Green
 * with main.cjs's early activation.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import capabilityLayer from '../../shell/capability-layer.cjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const HELPER = path.join(root, 'tools/test/helpers/owner-host-start-order.cjs')
const MARK = 'OWNER-HOST-START-ORDER '
const MAIN = readFileSync(path.join(root, 'shell/main.cjs'), 'utf8')

// Module-scope statements only (column 0): these run at load, in file order.
const STATE_ROOT_AT = MAIN.search(/^process\.env\.TOOLSENABLED_STATE_ROOT = CAPABILITY_STATE_ROOT$/m)
const HANDOFF_AT = MAIN.search(/^if \(ELECTRON_NODE_HANDOFF\?\.ok === true\) \{$/m)
const PLUGINS_AT = MAIN.search(/^const \w+ = require\('\.\/capability-layer\.cjs'\)\.activatePayloadPlugins\(/m)
const ORG_AT = MAIN.search(/^const agentOrgRecord = createAgentOrgRecord\(\)$/m)

function mainOrder() {
  const atLoad = [['plugins', PLUGINS_AT], ['org', ORG_AT]]
    .filter(([, at]) => at !== -1)
    .sort((left, right) => left[1] - right[1])
    .map(([step]) => step)
  return [...atLoad, 'ownerHost']
}

function run(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [HELPER, ...args], { cwd: root, env: { ...process.env }, timeout: 120000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const line = String(stdout).split('\n').find(text => text.startsWith(MARK))
        resolve({ code: error ? (error.code ?? 1) : 0, value: line ? JSON.parse(line.slice(MARK.length)) : null, stderr: String(stderr) })
      })
  })
}

function stateRoot(t) {
  const made = mkdtempSync(path.join(tmpdir(), 'owner-host-order-'))
  t.after(() => rmSync(made, { recursive: true, force: true }))
  return made
}

/* A neutral package, the shape tests/plugin-host.test.js in the engine builds:
   one tool it runs as a subprocess and one role. */
function installPlugin(state) {
  const pkg = path.join(state, 'state', 'plugin-packages', 'notes')
  mkdirSync(path.join(pkg, 'tools'), { recursive: true })
  mkdirSync(path.join(pkg, 'roles'), { recursive: true })
  writeFileSync(path.join(pkg, 'plugin.json'), JSON.stringify({
    schemaVersion: 1,
    name: 'notes',
    displayName: 'Notes',
    summary: 'Keeps a searchable index of your own notes.',
    requires: ['subprocess', 'roles'],
    provides: {
      roles: ['roles/archivist.json'],
      tools: [{
        name: 'reindex',
        summary: 'Rebuild the index for a folder of notes.',
        effect: 'local-read',
        run: { interpreter: 'node', script: 'tools/reindex.js' },
        params: [{ name: 'root', type: 'path', description: 'The folder to index.' }],
      }],
    },
  }, null, 2))
  writeFileSync(path.join(pkg, 'tools', 'reindex.js'), 'process.stdout.write("{}");\n')
  writeFileSync(path.join(pkg, 'roles', 'archivist.json'), JSON.stringify({
    id: 'archivist',
    displayName: 'Archivist',
    summary: 'Files a note where it will be found again.',
    owns: 'The index and its provenance: every note in it, and the folder each came from.',
    mustNot: 'Never delete a note, and never rewrite one it did not create.',
    handoff: 'Hands a finished index to the curator with the folder it was built from.',
  }, null, 2))
}

let withoutPlugin = null

test('main.cjs brings plugins up at load, after the state root and before its organisation record', () => {
  assert.notEqual(STATE_ROOT_AT, -1, 'main.cjs no longer publishes the state root where this test looks; update the test')
  assert.notEqual(HANDOFF_AT, -1, 'main.cjs no longer has the Node handoff where this test looks; update the test')
  assert.notEqual(ORG_AT, -1, 'main.cjs no longer builds its organisation record where this test looks; update the test')
  assert.notEqual(PLUGINS_AT, -1, 'main.cjs does not bring plugins up at module scope')
  assert.equal(PLUGINS_AT > STATE_ROOT_AT, true, 'plugins must come up after the state root is published')
  assert.equal(PLUGINS_AT > HANDOFF_AT, true, 'and after the Node handoff, which exits this process')
  assert.equal(PLUGINS_AT < ORG_AT, true, 'and before the organisation record loads the tool registry')
})

test('with no plugin installed, the owner host starts and nothing plugin-shaped appears', async t => {
  const started = await run(['start', stateRoot(t), JSON.stringify(mainOrder())])
  assert.equal(started.code, 0, started.stderr || JSON.stringify(started.value))
  const value = started.value
  assert.equal(value.ownerHost.ok, true, `the owner host did not start: ${value.ownerHost.code}`)
  assert.equal(value.brokerLoadedByOwnerHost, true)
  assert.equal(value.mcpTools.length > 0, true)
  assert.deepEqual(value.mcpTools.filter(name => name.startsWith('plugin.')), [])
  assert.equal(value.org.ok, true)
  assert.deepEqual(value.org.roles.filter(id => id.startsWith('notes-')), [])
  if (value.plugins) assert.deepEqual(value.plugins, { ok: true, activated: [], refused: [] })
  withoutPlugin = value
})

test('with a granted plugin, its tools reach the in-process MCP server and its role the organisation record', async t => {
  const state = stateRoot(t)
  installPlugin(state)
  const granted = await run(['grant', state, 'notes', JSON.stringify(['subprocess', 'roles'])])
  assert.equal(granted.code, 0, granted.stderr || JSON.stringify(granted.value))
  assert.deepEqual(granted.value.listed, { ok: true, names: ['notes'], refused: [] })
  assert.deepEqual(granted.value.granted, { ok: true, code: null, capabilities: ['subprocess', 'roles'] })

  const started = await run(['start', state, JSON.stringify(mainOrder())])
  assert.equal(started.code, 0, started.stderr || JSON.stringify(started.value))
  const value = started.value
  assert.equal(value.ownerHost.ok, true, `the owner host did not start: ${value.ownerHost.code}`)
  assert.equal(value.brokerLoadedByOwnerHost, true)
  assert.deepEqual(value.mcpTools.filter(name => name.startsWith('plugin.')), ['plugin.notes.reindex'])
  assert.equal(value.org.ok, true)
  assert.deepEqual(value.org.roles.filter(id => id.startsWith('notes-')), ['notes-archivist'])
  assert.deepEqual(value.plugins, { ok: true, activated: ['notes'], refused: [] })
  // The plugin ADDS; it changes nothing else the server offers or the record lists.
  if (withoutPlugin) {
    assert.deepEqual(value.mcpTools.filter(name => name !== 'plugin.notes.reindex'), withoutPlugin.mcpTools)
    assert.deepEqual(value.org.roles.filter(id => id !== 'notes-archivist'), withoutPlugin.org.roles)
  }
})

test('bringing plugins up never stops the app, and says why when it did not happen', () => {
  const { activatePayloadPlugins } = capabilityLayer
  const pass = (status, { throws = null } = {}) => () => ({
    activate() { if (throws) throw throws },
    status: () => status,
  })
  const present = () => true
  assert.equal(activatePayloadPlugins({ root: null }).code, 'PLUGIN_PAYLOAD_ABSENT')
  // A payload from before the plugin host: nothing to bring up, and it says so.
  assert.equal(activatePayloadPlugins({ root: '/payload', exists: () => false }).code, 'PLUGIN_ACTIVATION_ABSENT')
  const ok = { ok: true, activated: [], refused: [], skipped: [], registeredPacks: [] }
  assert.deepEqual(activatePayloadPlugins({ root: '/payload', exists: present, load: pass(ok) }), { ok: true, status: ok })
  // A pass that failed as a whole keeps its own code and sentence.
  const failed = activatePayloadPlugins({ root: '/payload', exists: present,
    load: pass({ ok: false, code: 'STATE_SCHEMA_INVALID', reason: 'the durable state store will not open' }) })
  assert.deepEqual(failed, { ok: false, code: 'STATE_SCHEMA_INVALID', reason: 'the durable state store will not open' })
  // A refusal thrown by activate() is an answer, not an exception.
  const refusal = Object.assign(new Error('Plugin activation ran after src/lib/tool-registry.js was already loaded.'),
    { code: 'PLUGIN_ACTIVATION_AFTER_REGISTRY' })
  const refused = activatePayloadPlugins({ root: '/payload', exists: present, load: pass(null, { throws: refusal }) })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'PLUGIN_ACTIVATION_AFTER_REGISTRY')
  // And a payload module that will not even load.
  const unloadable = activatePayloadPlugins({ root: '/payload', exists: present, load: () => { throw new SyntaxError('Unexpected token') } })
  assert.deepEqual([unloadable.ok, unloadable.code], [false, 'PLUGIN_ACTIVATION_FAILED'])
})

/* REVIEW T2 (1.0.49 merge review): the order check above compares two lines, so
   a NEW line loading the tool registry above activation passed it (4 of 4), and
   only the real app would have shown the granted plugin's tools missing. So
   every require main.cjs runs at load before activation is held to two rules: its
   argument is a literal (a payload module is only ever reached through a computed
   path, which is what this refuses), and a shell module among them loads no
   payload code when required. */
test('nothing main.cjs requires before bringing plugins up can load payload code', async () => {
  assert.notEqual(PLUGINS_AT, -1)
  const before = MAIN.slice(0, PLUGINS_AT)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ')
  const requires = [...before.matchAll(/\brequire\(\s*([^)]*?)\s*\)/g)].map(match => match[1])
  assert.ok(requires.length > 5, 'the requires above activation were found')
  const literal = /^'([^']+)'$/
  const computed = requires.filter(argument => !literal.test(argument))
  assert.deepEqual(computed, [], 'a require with a computed path above plugin activation can reach the payload')
  const named = requires.map(argument => argument.match(literal)[1])
  const outside = named.filter(name => !(name === 'electron' || name.startsWith('node:') || /^\.\/[\w.-]+\.cjs$/.test(name)))
  assert.deepEqual(outside, [], 'above activation, main.cjs requires only Node, Electron and its own shell modules')
  const shellModules = [...new Set(named.filter(name => name.startsWith('./')))]
  const probe = `
    const path = require('node:path');
    const Module = require('node:module');
    const realLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === 'electron') return new Proxy({}, { get: () => function () {} });
      return realLoad.apply(this, arguments);
    };
    for (const name of ${JSON.stringify(shellModules)}) require(path.join(${JSON.stringify(path.join(root, 'shell'))}, name));
    const payload = path.join(${JSON.stringify(root)}, 'capability') + path.sep;
    process.stdout.write(JSON.stringify(Object.keys(require.cache).filter(file => file.startsWith(payload))));
  `
  const loaded = await new Promise((resolve, reject) => {
    execFile(process.execPath, ['-e', probe], { cwd: root, env: { ...process.env }, timeout: 60000 },
      (error, stdout, stderr) => (error ? reject(Object.assign(error, { stderr })) : resolve(JSON.parse(String(stdout)))))
  })
  assert.deepEqual(loaded, [], 'a shell module required above activation loaded payload code at module scope')
})
