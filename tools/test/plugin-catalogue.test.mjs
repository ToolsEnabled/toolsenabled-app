/* THE SHELL'S PLUGIN DOOR, DRIVEN WITHOUT ELECTRON AND WITHOUT A PAYLOAD.
 *
 * shell/plugin-catalogue.cjs exists so that the reading and the deciding behind
 * the plugin consent screen can be proved here rather than by opening the app.
 * Four properties are worth a suite, and each one is a failure that would look
 * like working software:
 *
 *   1. A BROKEN PAYLOAD MUST NOT READ AS "NO PLUGINS". An empty list is an answer
 *      to a different question, and a person who gets it stops looking.
 *   2. A CAPABILITY NAME MUST BE CHECKED BEFORE IT REACHES THE GRANT STORE. The
 *      renderer is a window; whatever arrives from it is input.
 *   3. THE RENDERER MUST NOT BE ABLE TO NAME A PATH. A plugin is named by its
 *      digest, and the directory is found by matching that digest against a fresh
 *      listing -- so there is nothing to traverse.
 *   4. A PACKAGE THAT CHANGED SINCE THE SCREEN WAS DRAWN MUST NOT BE GRANTED. The
 *      person consented to bytes they read; different bytes are a different plugin.
 *
 * Mutations run, one at a time, each landed in shell/plugin-catalogue.cjs and
 * confirmed present before the run. Baseline and restored: green, 14 of 14.
 *   a. guard() re-threw instead of returning a failure -> red, 2 of 14 ('a host
 *      that cannot load is a sentence, not an empty list', and the grant-store
 *      refusal that has to reach the page as its own sentence).
 *   b. the unknown-capability check in grant() neutralised -> red, 1 of 14.
 *   c. grant() passed `request.root || found.root` to inspect() instead of the
 *      directory found by digest -> red, 1 of 14.
 *   d. the `identity.sha256 !== sha256` re-check removed -> red, 1 of 14.
 *
 * Run: node --test tools/test/plugin-catalogue.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const { createPluginCatalogue, CAPABILITY_VOCABULARY } = require('../../shell/plugin-catalogue.cjs')

const DIGEST = 'febdd76b95423581f2c6bc062a66f6b11e66827b05af3dd7adfaf5eee47843c5'
const OTHER = 'aaaa'.repeat(16)

function described(overrides = {}) {
  return {
    id: 'plugin-febdd76b95423581',
    sha256: DIGEST,
    root: '/packages/notes',
    fileCount: 15,
    name: 'notes',
    displayName: 'Notes',
    summary: 'Keeps a searchable index of your own notes.',
    requested: ['storage', 'subprocess', 'roles'],
    granted: [],
    inForce: [],
    withheld: ['storage', 'subprocess', 'roles'],
    effectFloor: 'local-read',
    tools: [],
    roleCount: 3,
    declaresSettings: false,
    declaresRestrictions: false,
    hasSkin: false,
    grantedAt: null,
    grantedBy: null,
    revoked: null,
    ...overrides,
  }
}

/* A fake host with the real shapes. The recorder is what the assertions read: what
   this catalogue asked the host and the grant store to do is the whole contract. */
function fakeHost({ packages = [described()], refused = [], inspectSha = DIGEST, inspectThrows = null } = {}) {
  const calls = []
  const host = {
    listPackages: (options) => { calls.push(['listPackages', options]); return { root: '/packages', packages, refused } },
    inspect: (directory) => {
      calls.push(['inspect', directory])
      if (inspectThrows) throw inspectThrows
      return {
        identity: { id: 'plugin-x', sha256: inspectSha, root: directory },
        manifest: { name: 'notes', requires: ['storage', 'subprocess', 'roles'], provides: { tools: [] } },
      }
    },
  }
  const grants = {
    grant: (request) => {
      calls.push(['grant', request])
      return {
        record: { capabilities: request.capabilities, approvalWaivers: request.approvalWaivers },
        audited: { recorded: true },
      }
    },
    revoke: (sha256, options) => {
      calls.push(['revoke', sha256, options])
      return { removed: true, alreadyRevoked: false, withdrawn: ['subprocess'] }
    },
  }
  return { host, grants, calls }
}

function catalogue(parts, options = {}) {
  return createPluginCatalogue({ load: () => parts, log: () => {}, ...options })
}

test('a host that cannot load is a sentence, not an empty list', () => {
  const broken = createPluginCatalogue({
    load: () => { const error = new Error('the capability payload is absent'); error.code = 'PAYLOAD_ABSENT'; throw error },
    log: () => {},
  })
  const result = broken.list()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'PAYLOAD_ABSENT')
  assert.match(result.reason, /payload is absent/)
  // Specifically NOT an empty packages array, which the page would draw as
  // "no plugins added".
  assert.equal(result.packages, undefined)
})

test('the listing carries the capability vocabulary with it', () => {
  // A renderer holding its own copy of the vocabulary drifts the moment one is
  // added, and the way it drifts is by not drawing one -- on a consent screen that
  // is a capability granted without being shown.
  const result = catalogue(fakeHost()).list()
  assert.equal(result.ok, true)
  assert.deepEqual(result.vocabulary, CAPABILITY_VOCABULARY)
  assert.deepEqual(CAPABILITY_VOCABULARY,
    ['storage', 'secrets', 'subprocess', 'network', 'auditLog', 'roles', 'settings', 'skin'])
})

test('no package path reaches the renderer', () => {
  const result = catalogue(fakeHost()).list()
  const [entry] = result.packages
  assert.equal(Object.hasOwn(entry, 'root'), false, 'a package directory is not the window\'s business')
  assert.equal(JSON.stringify(result.packages).includes('/packages/notes'), false)
  // The listing root IS sent: the page tells a person where to put a plugin, and
  // that directory is the app's own, not a package's.
  assert.equal(result.root, '/packages')
})

test('a refused directory is named in the listing rather than dropped', () => {
  const result = catalogue(fakeHost({
    packages: [],
    refused: [{ directory: 'broken', code: 'PLUGIN_MANIFEST_UNPARSEABLE', message: 'plugin.json is not valid JSON.' }],
  })).list()
  assert.equal(result.refused.length, 1)
  assert.equal(result.refused[0].code, 'PLUGIN_MANIFEST_UNPARSEABLE')
})

test('a capability outside the vocabulary never reaches the grant store', () => {
  const parts = fakeHost()
  const result = catalogue(parts).grant({ sha256: DIGEST, capabilities: ['subprocess', 'rootAccess'] })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'PLUGIN_REQUEST_INVALID')
  assert.match(result.reason, /rootAccess/)
  assert.equal(parts.calls.some(call => call[0] === 'grant'), false, 'nothing reached the grant store')
})

test('a malformed digest is refused before anything is read', () => {
  const parts = fakeHost()
  for (const bad of [undefined, '', 'not-a-digest', DIGEST.toUpperCase(), `${DIGEST}0`, '../../etc/passwd']) {
    const result = catalogue(parts).grant({ sha256: bad, capabilities: [] })
    assert.equal(result.ok, false, `${bad} was accepted`)
    assert.equal(result.code, 'PLUGIN_REQUEST_INVALID')
  }
  assert.equal(parts.calls.length, 0, 'not even a listing was read')
})

test('the renderer cannot name a directory: the digest is the lookup', () => {
  const parts = fakeHost()
  // A hostile request carrying a path alongside the digest.
  catalogue(parts).grant({ sha256: DIGEST, capabilities: ['subprocess'], root: '/etc', directory: '/etc' })
  const inspected = parts.calls.filter(call => call[0] === 'inspect').map(call => call[1])
  assert.deepEqual(inspected, ['/packages/notes'], 'the directory came from the listing, not the request')
})

test('a digest that is not among the packages is refused with the reason that helps', () => {
  const parts = fakeHost()
  const result = catalogue(parts).grant({ sha256: OTHER, capabilities: ['subprocess'] })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'PLUGIN_NOT_FOUND')
  // The likely cause, said out loud: they edited it.
  assert.match(result.reason, /changed its files it is now a different plugin/)
})

test('a package that changed between the screen and the decision is refused', () => {
  // The listing still shows the old digest; inspect() now reports a new one.
  const parts = fakeHost({ inspectSha: OTHER })
  const result = catalogue(parts).grant({ sha256: DIGEST, capabilities: ['subprocess'] })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'PLUGIN_CHANGED')
  assert.match(result.reason, /Nothing was granted/)
  assert.match(result.reason, /what you were shown is not what is there now/)
  assert.equal(parts.calls.some(call => call[0] === 'grant'), false)
})

test('a grant carries the whole set and says a restart is needed', () => {
  const parts = fakeHost()
  const result = catalogue(parts).grant({
    sha256: DIGEST, capabilities: ['subprocess', 'roles'], approvalWaivers: ['reindex'],
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.capabilities, ['subprocess', 'roles'])
  assert.deepEqual(result.approvalWaivers, ['reindex'])
  assert.equal(result.audited, true)
  // Without this the person grants something and wonders why no tool appeared.
  assert.equal(result.restartRequired, true)
  const [, request] = parts.calls.find(call => call[0] === 'grant')
  assert.equal(typeof request.actor, 'string')
  assert.ok(request.actor.length > 0, 'an audited decision needs an actor')
})

test('an empty capability list is a valid decision: allow nothing', () => {
  const parts = fakeHost()
  const result = catalogue(parts).grant({ sha256: DIGEST, capabilities: [] })
  assert.equal(result.ok, true)
  assert.deepEqual(result.capabilities, [])
  assert.ok(parts.calls.some(call => call[0] === 'grant'), 'allowing nothing still reaches the grant store, which decides what to record')
})

test('each card says whether an allowed plugin started in this session, and why not', () => {
  // 1.0.50 release review F6: a plugin refused at start (here, a missing
  // interpreter) was shown as allowed and working; the refusal reached only the
  // console. Red before (no `running` on any entry), green after.
  const allowed = { granted: ['subprocess', 'roles'], inForce: ['subprocess', 'roles'], withheld: ['storage'] }
  const SECOND = 'bbbb'.repeat(16)
  const THIRD = 'cccc'.repeat(16)
  const FOURTH = 'dddd'.repeat(16)
  const parts = fakeHost({ packages: [
    described({ ...allowed }),
    described({ ...allowed, sha256: OTHER, root: '/packages/b', name: 'b' }),
    described({ ...allowed, sha256: SECOND, root: '/packages/c', name: 'c' }),
    described({ ...allowed, sha256: THIRD, root: '/packages/d', name: 'd' }),
    described({ sha256: FOURTH, root: '/packages/e', name: 'e' }),
  ] })
  parts.host.contributions = () => ({ settings: [], restrictions: null, skin: {}, roles: [], refused: [] })
  const status = {
    ok: true,
    activated: [{ sha256: DIGEST }, { sha256: THIRD }],
    refused: [
      { directory: 'b', sha256: OTHER, part: 'package', code: 'PLUGIN_INTERPRETER_MISSING', message: 'This plugin needs python3.' },
      { directory: 'd (roles)', sha256: THIRD, part: 'roles', code: 'PLUGIN_ROLE_INVALID', message: 'roles/x.json is not readable JSON.' },
      { directory: 'broken', code: 'PLUGIN_MANIFEST_UNPARSEABLE', message: 'a folder with no card' },
    ],
    skipped: [],
  }
  const listed = catalogue(parts, { activation: () => ({ ok: true, status }) }).list()
  const running = Object.fromEntries(listed.packages.map(entry => [entry.name, entry.running]))
  assert.deepEqual(running.notes, { state: 'running' })
  assert.deepEqual(running.b, { state: 'not-running', reason: 'This plugin needs python3.' })
  assert.deepEqual(running.c, { state: 'not-yet' }, 'allowed after the app started, or added since')
  assert.deepEqual(running.d, { state: 'partly', parts: [{ part: 'roles', message: 'roles/x.json is not readable JSON.' }] })
  assert.equal(running.e, null, 'nothing allowed: the state sentence already says so')
  // A start that failed as a whole is not "running", and the reason travels.
  const failed = catalogue(parts, { activation: () => ({ ok: false, code: 'STATE_SCHEMA_INVALID', reason: 'The store will not open.' }) }).list()
  assert.equal(failed.packages[0].running.state, 'not-running')
  assert.match(failed.packages[0].running.reason, /The store will not open/)
  // Not known says nothing, rather than guessing.
  assert.equal(catalogue(parts).list().packages[0].running, null)
})

test('the page’s listing asks the host to make the plugin folder it names', () => {
  // 1.0.50 release review F13. Red before (no `create`), green after.
  const parts = fakeHost()
  catalogue(parts).list()
  const [, options] = parts.calls.find(call => call[0] === 'listPackages')
  assert.equal(options.create, true)
})

test('a grant tells the store which packages are on this computer, so only they count toward its limit', () => {
  // 1.0.50 release review F5: the store counted every live record ever written,
  // including old versions no longer on disk, and after enough updates refused
  // every new plugin. It now counts the packages it is told are here. Red before
  // (no `present` was passed), green after.
  const parts = fakeHost({ packages: [described(), described({ sha256: OTHER, root: '/packages/other', name: 'other' })] })
  const result = catalogue(parts).grant({ sha256: DIGEST, capabilities: ['subprocess'] })
  assert.equal(result.ok, true)
  const [, request] = parts.calls.find(call => call[0] === 'grant')
  assert.deepEqual(request.present, [DIGEST, OTHER])
})

test('a refusal from the grant store reaches the page as its own sentence', () => {
  const parts = fakeHost()
  parts.grants.grant = () => {
    const error = new Error('This plugin did not ask for "secrets", so it cannot be granted it.')
    error.code = 'PLUGIN_GRANT_NOT_REQUESTED'
    throw error
  }
  const result = catalogue(parts).grant({ sha256: DIGEST, capabilities: ['subprocess'] })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'PLUGIN_GRANT_NOT_REQUESTED')
  assert.match(result.reason, /did not ask for "secrets"/)
})

test('revoke needs a digest, records a reason, and reports what was withdrawn', () => {
  const parts = fakeHost()
  assert.equal(catalogue(parts).revoke({ sha256: 'nope' }).code, 'PLUGIN_REQUEST_INVALID')
  const result = catalogue(parts).revoke({ sha256: DIGEST, reason: 'x'.repeat(400) })
  assert.equal(result.ok, true)
  assert.equal(result.removed, true)
  assert.deepEqual(result.withdrawn, ['subprocess'])
  assert.equal(result.restartRequired, true)
  const [, , options] = parts.calls.find(call => call[0] === 'revoke')
  assert.equal(options.reason.length, 200, 'a reason is bounded before it is stored')
})

test('revoking something that already has nothing is not an error', () => {
  const parts = fakeHost()
  parts.grants.revoke = () => ({ removed: false, alreadyRevoked: true, withdrawn: null })
  const result = catalogue(parts).revoke({ sha256: DIGEST })
  assert.equal(result.ok, true)
  assert.equal(result.removed, false)
  assert.equal(result.alreadyRevoked, true)
  assert.deepEqual(result.withdrawn, [])
  assert.equal(result.restartRequired, false, 'nothing changed, so nothing needs a restart')
})

test('a plugin role hidden by a role of the person’s own is named in the listing', () => {
  // HP-34, 1.0.49 plugins walk: the person's own role of the same id wins, and the
  // page went on saying the plugin adds both roles. The catalogue asks for the
  // person's own role ids and names the plugin's roles they hide.
  const parts = fakeHost({ packages: [described({ granted: ['roles'], inForce: ['roles'], withheld: ['storage', 'subprocess'] })] })
  parts.host.contributions = () => ({
    settings: [], restrictions: null, skin: {}, refused: [],
    roles: [{ id: 'notes-archivist' }, { id: 'notes-curator' }],
  })
  const listed = catalogue(parts, { storedRoleIds: () => ['notes-archivist', 'mine'] }).list()
  assert.equal(listed.ok, true)
  assert.deepEqual(listed.packages[0].roles, ['notes-archivist', 'notes-curator'])
  assert.deepEqual(listed.packages[0].shadowedRoles, ['notes-archivist'])
  assert.deepEqual(catalogue(parts).list().packages[0].shadowedRoles, [], 'with nothing to ask, nothing is hidden')
  const failing = catalogue(parts, { storedRoleIds: () => { throw new Error('role file unreadable') } }).list()
  assert.equal(failing.ok, true, 'the person’s role file failing to read does not cost the plugin list')
  assert.deepEqual(failing.packages[0].shadowedRoles, [])
})

test('every plugin channel refuses a frame that is not the app’s own before the catalogue is reached', async () => {
  // Review T1: removing the sender check from mc-plugins:grant passed every
  // sender-aware main.cjs test and the plugin tests. The three channels are run
  // from main.cjs's own text, the way the video channels are.
  const vm = await import('node:vm')
  const MAIN = fs.readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
  const first = MAIN.indexOf("ipcMain.handle('mc-plugins:list'")
  const lastStart = MAIN.indexOf("ipcMain.handle('mc-plugins:revoke'")
  assert.ok(first >= 0 && lastStart > first, 'main registers the plugin channels together')
  const block = MAIN.slice(first, MAIN.indexOf('\n})', lastStart) + 3)
  const handlers = new Map()
  const calls = []
  const catalogue = Object.fromEntries(['list', 'grant', 'revoke'].map(name =>
    [name, (value) => { calls.push({ name, value }); return { ok: true, name } }]))
  vm.runInNewContext(block, {
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    assertTrustedAgentSender: event => { if (event?.trusted !== true) throw Object.assign(new Error('refused'), { code: 'MC_AGENT_SENDER_REFUSED' }) },
    plugins: () => catalogue,
  })
  assert.deepEqual([...handlers.keys()].sort(), ['mc-plugins:grant', 'mc-plugins:list', 'mc-plugins:revoke'])
  for (const [channel, handler] of handlers) {
    const name = channel.slice('mc-plugins:'.length)
    await assert.rejects(async () => handler({ trusted: false }, { sha256: 'a'.repeat(64) }), { code: 'MC_AGENT_SENDER_REFUSED' }, channel)
    assert.equal(calls.length, 0, `${channel} reached the catalogue from an untrusted frame`)
    assert.deepEqual(await handler({ trusted: true }, { sha256: 'a'.repeat(64) }), { ok: true, name })
    assert.equal(calls.pop().name, name)
  }
})
