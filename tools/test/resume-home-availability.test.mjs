import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createAgentHost } from '../../shell/agent-host.cjs'
import { mountAgentSessionSurface } from '../../src/agent-session.js'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { testScratchRoot } from '../lib/test-scratch-root.mjs'
import { unavailableReason } from '../../src/agent-availability-copy.js'
import { engineReason } from '../../src/local-activity.js'

const require = createRequire(import.meta.url)
const ENGINE = require.resolve('./fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
const claude = require('./fixtures/confined-engine/src/lib/agent-engine/claude-cli-process.js')
const { createAccountRegistryStore } = require('../../shell/account-registry.cjs')

async function fixture(t) {
  const scratch = testScratchRoot('.toolsenabled-resume-home-availability')
  mkdirSync(scratch, { recursive: true })
  const cwd = mkdtempSync(path.join(scratch, 'run-'))
  const originalHome = path.join(cwd, 'original'), differentHome = path.join(cwd, 'different')
  let home = originalHome, signedIn = 'yes'
  let lookup = () => home
  const launches = [], probes = []
  const native = async options => {
    launches.push(options)
    return { threadId: options.threadId || 'saved-thread', close() {},
      adapter: { sendTurn: async () => ({ turnId: 'turn' }), interrupt: async () => {} } }
  }
  t.mock.method(claude, 'startClaudeSession', native)
  t.mock.method(claude, 'resumeClaudeSession', native)
  const host = createAgentHost({ enginePath: ENGINE, defaultCwd: cwd,
    profileRoot: process.platform === 'win32' ? os.homedir() : path.parse(cwd).root,
    freeMemory: () => 64 * 1024 ** 3, providerSignIn: () => signedIn,
    resumeAccountHome: (...args) => lookup(...args),
    accountResolver: async request => { probes.push(request)
      return { rotated: true, account: { name: 'saved-account', provider: 'claude', resolvedHome: home } } },
    confinementPlanner: options => ({ ok: true, tier: 'unrestricted', isolated: false,
      account: options?.account?.name || null, threadOptions: {}, configDir: home }),
  })
  t.after(async () => { await host.closeAll(); rmSync(cwd, { recursive: true, force: true }) })
  return { host, launches, probes, originalHome, differentHome,
    setHome(value) { home = value }, setLookup(value) { lookup = value },
    setSignIn(value) { signedIn = value }, signOut() { signedIn = 'no' } }
}

test('C7-W2: a registered rename keeps the saved label bound to the same account home', async t => {
  const f = await fixture(t)
  const first = await f.host.startSession({ sessionId: 'original', tier: 'claude-sonnet' })
  await f.host.closeSession({ sessionId: first.sessionId })
  const file = path.join(path.dirname(f.originalHome), 'accounts.json')
  writeFileSync(file, JSON.stringify({ accounts: [{ name: first.account, provider: 'claude', configDir: f.originalHome }] }))
  const registry = createAccountRegistryStore({ file, homedir: () => path.dirname(file) })
  registry.rename({ name: first.account, provider: 'claude', newName: 'current-label' })
  f.setLookup((name, provider) => registry.homeOf({ name, provider }, { allowPreviousNames: true }).directory)
  const resumed = await f.host.startSession({ sessionId: 'resumed', tier: 'claude-sonnet',
    resumeThreadId: first.threadId, resumeThreadProvider: 'claude', resumeSessionId: first.sessionId, resumeAccount: first.account })
  assert.equal(resumed.threadId, first.threadId)
  assert.equal(resumed.account, first.account, 'display renaming must not replace the saved identity')
  assert.equal(f.launches.length, 2)
  assert.equal(f.launches[1].configDir, f.originalHome)
  assert.equal(f.probes[1].preferred, first.account)
})

test('C7-W2: a fresh signed-out account keeps the existing sign-in refusal before probing or launching', async t => {
  const f = await fixture(t)
  f.signOut()
  assert.deepEqual(f.host.startableTiers({ tier: 'claude-sonnet' }),
    { ok: false, tier: 'claude-sonnet', code: 'AGENT_TIER_NO_SIGNED_IN_ACCOUNT' })
  assert.throws(() => f.host.startSession({ sessionId: 'fresh', tier: 'claude-sonnet' }),
    { code: 'AGENT_TIER_NO_SIGNED_IN_ACCOUNT' })
  assert.deepEqual(f.launches, []); assert.deepEqual(f.probes, [])
})

test('C7-W2: an unchanged saved home still refuses missing sign-in before probing or launching', async t => {
  const f = await fixture(t)
  const first = await f.host.startSession({ sessionId: 'original', tier: 'claude-sonnet' })
  await f.host.closeSession({ sessionId: first.sessionId })
  f.signOut()
  await assert.rejects(async () => f.host.startSession({ sessionId: 'resumed', tier: 'claude-sonnet',
    resumeThreadId: first.threadId, resumeThreadProvider: 'claude', resumeSessionId: first.sessionId, resumeAccount: first.account }),
    { code: 'AGENT_TIER_NO_SIGNED_IN_ACCOUNT' })
  assert.equal(f.launches.length, 1); assert.equal(f.probes.length, 1)
})

for (const homeState of ['changed', 'missing', 'relative']) {
  test(`C7-W2: ${homeState} saved account home refuses before an unknown sign-in or account probe can launch`, async t => {
    const f = await fixture(t)
    const first = await f.host.startSession({ sessionId: 'original', tier: 'claude-sonnet' })
    await f.host.closeSession({ sessionId: first.sessionId })
    f.setSignIn('unknown')
    f.setHome(homeState === 'changed' ? f.differentHome : homeState === 'relative' ? 'relative-home' : null)
    const code = homeState === 'changed' ? 'AGENT_RESUME_HOME_CHANGED' : 'AGENT_RESUME_HOME_UNAVAILABLE'
    await assert.rejects(async () => f.host.startSession({ sessionId: 'resumed', tier: 'claude-sonnet',
      resumeThreadId: first.threadId, resumeThreadProvider: 'claude', resumeSessionId: first.sessionId, resumeAccount: first.account }), { code })
    assert.equal(f.launches.length, 1); assert.equal(f.probes.length, 1)
  })
}

for (const retained of [false, true]) test(`C7-W2: ${retained ? 'saved renderer keeps other availability refusals' : 'fresh renderer keeps its selected-tier sign-in refusal'} and never asks the host to start`, async t => {
  const dom = installDomStandIn()
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  globalThis.localStorage = { getItem: key => key === 'mc.write.agent-session' ? 'enabled' : null,
    setItem() {}, removeItem() {} }
  const root = document.createElement('div'); document.body.appendChild(root)
  const starts = []
  let control
  const dispose = mountAgentSessionSurface(root, { live: true, chatComposer: true,
    ...(retained ? { resumeConversation: { sessionId: 'saved-native', threadId: 'saved-thread', provider: 'claude', account: 'saved-account' } } : {}),
    getAvailabilityOptions: () => ({ tier: 'claude-sonnet' }), onController: value => { control = value },
    bridge: { availability: async () => ({ ok: false, code: retained ? 'AGENT_TIER_NO_LAUNCHER' : 'AGENT_TIER_NO_SIGNED_IN_ACCOUNT' }),
      onEvent: () => () => {}, start: async request => { starts.push(request); return { ok: true } },
      send: async () => ({}), close: async () => ({ closed: true }), interrupt: async () => ({ ok: true }) } })
  t.after(() => { dispose(); if (prior) Object.defineProperty(globalThis, 'localStorage', prior); else delete globalThis.localStorage; dom.restore() })
  const answer = await control.send('A fresh message')
  assert.equal(answer.ok, false)
  assert.match(root.textContent, retained ? /no launcher/i : /no account is signed in/i)
  assert.deepEqual(starts, [])
})

for (const platform of ['win32', 'linux']) {
  test(`C7-W2: ${platform} agent page and Home both explain changed home and preserved conversation`, () => {
    for (const sentence of [unavailableReason('AGENT_RESUME_HOME_CHANGED'), engineReason('AGENT_RESUME_HOME_CHANGED', { platform })]) {
      assert.match(sentence, /different sign-in folder/i)
      assert.match(sentence, /conversation is kept/i)
      assert.match(sentence, /choose the account again/i)
    }
  })
}
