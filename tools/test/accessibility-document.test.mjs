import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import vm from 'node:vm'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createAccessibilityAppAdapter } = require('../../shell/accessibility-app.cjs')
const { createAccessibilityHost } = require('../../shell/accessibility-host.cjs')
const { createVoiceHost } = require('../../shell/voice-host.cjs')
const { createScreenControlHost } = require('../../shell/screen-control-host.cjs')
const main = fs.readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
const ORIGIN = 'http://127.0.0.1:4600'

// Execute the actual injected function in a new isolated world for each
// document. Replacing that world models navigation at the queued execution
// boundary; the existing Electron UI suite checks the real browser adapter.
function fixture() {
  let current, beforeExecute = null, executions = 0, desktopLease = false
  const documents = []
  function replace(url = ORIGIN + '/') {
    const location = new URL(url)
    const document = { reads: 0, querySelectorAll() { this.reads++; return [] } }
    current = { location, document, context: vm.createContext({
      location, document, crypto: { randomUUID }, Map, WeakRef, Date,
    }) }
    documents.push(current)
  }
  replace()
  const owner = {
    isDestroyed: () => false,
    getURL: () => current.location.href,
    async executeJavaScriptInIsolatedWorld(world, scripts) {
      assert.equal(world, 1004)
      executions++
      const hook = beforeExecute; beforeExecute = null
      if (hook) await hook()
      return vm.runInContext(scripts[0].code, current.context)
    },
  }
  owner.mainFrame = { get url() { return owner.getURL() } }
  const adapter = createAccessibilityAppAdapter({
    profileRoot: 'C:\\Users\\ToolsEnabled-Dev',
    trustedOrigin: candidate => candidate === owner && current.location.origin === ORIGIN ? ORIGIN : null,
  })
  const principal = { kind: 'agent-session', sessionId: 'document-session', agentId: 'document-agent',
    roleId: 'document-role', expectedRoleRevision: 1 }
  const sessions = new Map([[principal.sessionId, { owner, ownerKind: 'window', agentId: principal.agentId, state: 'ready' }]])
  const host = createAccessibilityHost({
    sessions,
    readBinding: () => ({ enabled: true, roleId: principal.roleId, revision: 1, functions: ['accessibility.propose'] }),
    permissionLevel: () => 'standard', isDirectUserTurn: () => true,
    planAction: (input, mode) => adapter.plan(input, mode), inspect: (_input, mode) => adapter.inspect(mode),
    audit: async () => {},
  })
  const screenHost = createScreenControlHost({
    sessions,
    readBinding: () => ({ enabled: true, roleId: principal.roleId, revision: 1, functions: ['screen.control'] }),
    permissionLevel: () => 'unrestricted', adapter: { supported: () => true },
    indicator: { ready: async () => { desktopLease = true }, show() {}, hide() {},
      release() { desktopLease = false } }, audit: async () => {},
  })
  // No voice contact is active. Its close() must not be what revokes controls.
  const voiceHost = createVoiceHost({ sessions, emit: () => {}, onEnd: (_owner, id) => host.revokeSession(id) })
  let navigation
  const start = main.indexOf("  window.webContents.on('did-start-navigation', details => {")
  const end = main.indexOf("  window.webContents.on('did-finish-load'", start)
  assert.ok(start >= 0 && end > start)
  vm.runInNewContext(main.slice(start, end), {
    window: { webContents: { on: (_name, handler) => { navigation = handler } } },
    treeNodeCommandBroker: { rendererReloaded: async () => {} },
    handCameraOwners: new Set([owner]), inputOwner: owner,
    voiceHost, accessibilityHost: host, accessibilityApp: adapter, screenControlHost: screenHost,
  })
  const consent = () => {
    const pending = host.state(owner).pending
    return { requestId: pending.requestId, code: pending.confirmationCode }
  }
  return {
    owner, adapter, host, screenHost, principal, documents, replace,
    mode: { owner, controller: new AbortController() },
    hook: fn => { beforeExecute = fn },
    executions: () => executions,
    desktopLease: () => desktopLease,
    navigation, consent,
    async enable() {
      host.prepareEnable(owner, { sessionId: principal.sessionId, scope: 'application' })
      await host.confirm(owner, consent())
      await screenHost.grant(owner, { sessionIds: [principal.sessionId] })
    },
    close: () => { host.close(owner); screenHost.close(owner) },
  }
}

test('full document navigation revokes Accessibility, screen grants and pending consent without voice', async t => {
  const f = fixture(); t.after(f.close)
  await f.enable()
  assert.equal(f.desktopLease(), true)
  await f.host.propose(f.principal, { kind: 'navigate', route: '/settings' })
  const stale = f.consent()
  f.navigation({ isMainFrame: true, isSameDocument: false })
  assert.equal(f.host.state(f.owner).enabled, false)
  assert.equal(f.host.state(f.owner).pending, null)
  assert.equal(f.screenHost.state(f.owner).grants.length, 0)
  assert.equal(f.desktopLease(), false, 'a replaced document releases its idle desktop reservation')
  assert.equal(f.screenHost.status(f.principal).enabled, false)
  assert.throws(() => f.screenHost.control(f.principal, { action: 'click' }), { code: 'SCREEN_ACCESS_OFF' })
  await assert.rejects(f.host.confirm(f.owner, stale), { code: 'ACCESSIBILITY_CONFIRMATION_INVALID' })
  await assert.rejects(f.host.inspect(f.principal, {}), { code: 'ACCESSIBILITY_OFF' })
  assert.equal(f.executions(), 0)
  f.replace()
  await f.enable()
  assert.equal(f.host.state(f.owner).enabled, true, 'the owner can explicitly enable the new document')
  await f.host.inspect(f.principal, {})
})

test('subframes and hash navigation preserve the current local control session', async t => {
  const f = fixture(); t.after(f.close)
  await f.enable()
  assert.equal(f.screenHost.state(f.owner).grants.length, 1)
  f.navigation({ isMainFrame: false, isSameDocument: false })
  f.navigation({ isMainFrame: true, isSameDocument: true })
  assert.equal(f.screenHost.state(f.owner).grants.length, 1)
  assert.equal(f.host.state(f.owner).enabled, true)
  assert.equal(f.desktopLease(), true, 'same-document navigation keeps the existing reservation')
  await f.host.inspect(f.principal, {})
  await f.host.propose(f.principal, { kind: 'navigate', route: '/settings' })
  assert.equal((await f.host.confirm(f.owner, f.consent())).status, 'completed')
  assert.equal(new URL(f.owner.getURL()).hash, '#/settings')
  assert.equal(f.host.state(f.owner).enabled, true)
})

test('the app adapter rejects an untrusted document before scheduling script execution', async t => {
  const f = fixture(); t.after(f.close)
  f.replace('https://outside-document.invalid/')
  await assert.rejects(f.adapter.inspect(f.mode), /document|trusted/i)
  await assert.rejects(f.adapter.navigate(f.owner, '/settings'), /document|trusted/i)
  assert.equal(f.executions(), 0)
  assert.equal(f.documents.at(-1).document.reads, 0)
})

for (const next of [ORIGIN + '/', 'https://outside-document.invalid/']) {
  test('a document swap after validation cannot receive a queued operation: ' + next, async t => {
    const f = fixture(); t.after(f.close)
    await f.adapter.inspect(f.mode)
    const action = f.adapter.plan({ kind: 'navigate', route: '/settings' }, f.mode)
    f.hook(() => f.replace(next))
    await assert.rejects(action.execute(f.mode.controller.signal), /document|trusted/i)
    assert.equal(new URL(f.owner.getURL()).hash, '')
    assert.equal(f.documents.at(-1).document.reads, 0)
  })
}

test('a planned operation cannot move to a replacement document after explicit re-enable', async t => {
  const f = fixture(); t.after(f.close)
  await f.adapter.inspect(f.mode)
  const action = f.adapter.plan({ kind: 'navigate', route: '/settings' }, f.mode)
  f.navigation({ isMainFrame: true, isSameDocument: false })
  f.replace()
  await f.enable()
  await f.host.inspect(f.principal, {})
  await assert.rejects(action.execute(f.mode.controller.signal), /document|trusted/i)
  assert.equal(new URL(f.owner.getURL()).hash, '')
})

test('navigation while the private document binding is pending cannot admit inspection', async t => {
  const f = fixture(); t.after(f.close)
  f.hook(() => {
    f.navigation({ isMainFrame: true, isSameDocument: false })
    f.replace()
  })
  await assert.rejects(f.adapter.inspect(f.mode), /document|trusted/i)
  assert.equal(f.documents.at(-1).document.reads, 0)
})
