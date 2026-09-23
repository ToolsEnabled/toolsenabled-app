import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createAccessibilityHost, confirmationDigits } = require('../../shell/accessibility-host.cjs')

function fixture(overrides = {}) {
  const owner = { isDestroyed: () => false }, other = { isDestroyed: () => false }
  let roleRevision = 1, direct = true, time = 1000, tier = 'unrestricted', executions = 0
  const events = [], audit = []
  const sessions = new Map([['s', { owner, ownerKind: 'window', agentId: 'helper', state: 'ready' }]])
  const principal = { kind: 'agent-session', sessionId: 's', agentId: 'helper', roleId: 'custom-role', expectedRoleRevision: 1 }
  const host = createAccessibilityHost({
    sessions, readBinding: () => ({ enabled: true, roleId: 'custom-role', revision: roleRevision, functions: ['accessibility.propose'] }),
    permissionLevel: () => tier, isDirectUserTurn: () => direct, now: () => time, makeCode: () => '1234',
    planAction: async () => ({ kind: 'navigate', summary: 'Open Settings', execute: async signal => {
      assert.equal(signal.aborted, false); executions++; return { status: 'completed' }
    } }),
    inspect: async () => ({ controls: [] }), audit: async event => audit.push(event),
    emit: (_, event) => events.push(event), ...overrides,
  })
  const consent = () => ({ requestId: host.state(owner).pending.requestId, code: host.state(owner).pending.confirmationCode })
  const enable = async () => { host.prepareEnable(owner, { sessionId: 's' }); return host.confirm(owner, consent()) }
  return { host, owner, other, principal, consent, enable, audit, events, sessions,
    setDirect: value => { direct = value }, setRevision: value => { roleRevision = value },
    setTime: value => { time = value }, setTier: value => { tier = value }, count: () => executions }
}

test('off by default; opt-in and each action require separate exact one-use confirmation', async () => {
  const f = fixture()
  assert.equal(f.host.state(f.owner).enabled, false)
  await assert.rejects(f.host.propose(f.principal, {}), { code: 'ACCESSIBILITY_OFF' })
  f.host.prepareEnable(f.owner, { sessionId: 's' })
  const enable = f.consent()
  assert.equal(f.host.state(f.owner).enabled, false)
  assert.equal(f.host.status(f.principal).pending.confirmationCode, undefined, 'the model never receives its own confirmation code')
  await assert.rejects(f.host.confirm(f.other, enable), { code: 'ACCESSIBILITY_CONFIRMATION_INVALID' })
  await f.host.confirm(f.owner, enable)
  await assert.rejects(f.host.confirm(f.owner, enable), { code: 'ACCESSIBILITY_CONFIRMATION_INVALID' })
  const proposal = await f.host.propose(f.principal, {})
  assert.equal(proposal.status, 'awaiting-user-confirmation')
  assert.equal(f.count(), 0)
  const action = f.consent()
  await assert.rejects(f.host.confirm(f.owner, { ...action, code: '9999' }), { code: 'ACCESSIBILITY_CONFIRMATION_INVALID' })
  await f.host.confirm(f.owner, action)
  assert.equal(f.count(), 1)
  await assert.rejects(f.host.confirm(f.owner, action), { code: 'ACCESSIBILITY_CONFIRMATION_INVALID' })
  assert.equal(f.count(), 1)
  f.host.disable(f.owner)
})

test('agent-origin work, stale role, expired confirmation and permission downgrades refuse', async () => {
  const f = fixture()
  f.setTier('guided')
  assert.throws(() => f.host.prepareEnable(f.owner, { sessionId: 's' }), { code: 'ACCESSIBILITY_PERMISSION_REQUIRED' })
  f.setTier('unrestricted')
  await f.enable()
  f.setDirect(false)
  await assert.rejects(f.host.propose(f.principal, {}), { code: 'ACCESSIBILITY_DIRECT_REQUEST_REQUIRED' })
  f.setDirect(true)
  await f.host.propose(f.principal, {})
  const expired = f.consent()
  f.setTime(100000)
  await assert.rejects(f.host.confirm(f.owner, expired), { code: 'ACCESSIBILITY_CONFIRMATION_INVALID' })
  f.host.reject(f.owner)
  f.setRevision(2)
  await assert.rejects(f.host.propose(f.principal, {}), { code: 'ACCESSIBILITY_ROLE_CHANGED' })
  assert.equal(f.host.state(f.owner).enabled, false)
  assert.equal(f.count(), 0)
})

test('stop revokes an opt-in while its audit is pending', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const f = fixture({ audit: () => gate })
  f.host.prepareEnable(f.owner, { sessionId: 's' })
  const confirming = f.host.confirm(f.owner, f.consent())
  f.host.disable(f.owner)
  release()
  assert.equal((await confirming).status, 'canceled')
  assert.equal(f.host.state(f.owner).enabled, false)
})

test('stop during awaited action admission prevents execution; stale consent stays spent', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const f = fixture({ audit: event => event.event === 'action-authorized' ? gate : Promise.resolve() })
  await f.enable()
  await f.host.propose(f.principal, {})
  const consent = f.consent()
  const confirming = f.host.confirm(f.owner, consent)
  f.host.disable(f.owner)
  release()
  assert.equal((await confirming).status, 'canceled')
  assert.equal(f.count(), 0)
  await assert.rejects(f.host.confirm(f.owner, consent), { code: 'ACCESSIBILITY_CONFIRMATION_INVALID' })
})

test('voice controls are consumed locally; partial stop is immediate and codes are bounded', async () => {
  const f = fixture()
  await f.enable()
  await f.host.propose(f.principal, {})
  assert.equal(f.host.onVoice(f.owner, { type: 'transcript.partial', text: 'stop accessibility', targetAgentId: 's' }), true)
  assert.equal(f.host.state(f.owner).enabled, false)
  assert.equal(f.host.state(f.owner).pending, null)
  assert.equal(f.count(), 0)
  assert.equal(confirmationDigits('Confirm action one two three four.'), '1234')
  assert.equal(confirmationDigits('confirm action 1234'), '1234')
  assert.equal(confirmationDigits('confirm action yes'), null)
  assert.equal(f.host.onVoice(f.owner, { type: 'transcript.final', sequence: 8, generation: 1,
    sessionId: 'voice-1', targetAgentId: 's', text: 'reject action' }), true)
  assert.equal(f.host.onVoice(f.owner, { type: 'transcript.final', sequence: 8, generation: 1,
    sessionId: 'voice-1', targetAgentId: 's', text: 'reject action' }), true, 'replayed control speech must not become agent work')
})

test('spoken confirmation accepts exact four-digit STT formats, never guesses a code', async () => {
  for (const text of ['1234', '1 2 3 4', '12 34', 'one 2 three 4', '1,234', 'one, two, three, four.']) {
    assert.equal(confirmationDigits('confirm action ' + text), '1234')
  }
  for (const text of ['123', '12345', 'one two three', 'one two three four five', 'one to three for', 'yes 1234', '1234 please']) {
    assert.equal(confirmationDigits('confirm action ' + text), null)
  }
  const f = fixture()
  const packet = (text, sequence) => ({ type: 'transcript.final', sessionId: 'voice', generation: 1, targetAgentId: 's', text, sequence })
  f.host.prepareEnable(f.owner, { sessionId: 's' })
  const request = f.consent()
  assert.equal(f.host.onVoice(f.owner, packet('confirm action 1 2 3 4', 1)), true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.host.state(f.owner).enabled, true)
  assert.equal(f.host.onVoice(f.owner, packet('confirm action 1 2 3 4', 1)), true)
  await assert.rejects(f.host.confirm(f.owner, request), { code: 'ACCESSIBILITY_CONFIRMATION_INVALID' })
  f.host.disable(f.owner)
})

test('bare codes stay local while pending, prompt for explicit consent, and never approve', async () => {
  const announcements = []
  const f = fixture({ announce: (_, __, text) => announcements.push(text) })
  f.host.prepareEnable(f.owner, { sessionId: 's' })
  let sequence = 0
  const packet = text => ({ type: 'transcript.final', sessionId: 'voice', generation: 1, targetAgentId: 's', text, sequence: ++sequence })
  for (const text of ['1234', 'one two three four', 'the key is 1 2 3 4', 'the password is 1234', 'confirm action']) {
    assert.equal(f.host.onVoice(f.owner, packet(text)), true)
    assert.equal(f.host.state(f.owner).enabled, false)
    assert.ok(f.host.state(f.owner).pending)
  }
  assert.equal(f.host.onVoice(f.owner, packet('Open Settings')), false)
  assert.equal(f.host.onVoice(f.owner, { ...packet('1234'), targetAgentId: 'other' }), false)
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(announcements.slice(1).every(text => /Nothing was approved/.test(text) && !text.includes('1234')))
  assert.equal(f.count(), 0)
  f.host.reject(f.owner)
  assert.equal(f.host.onVoice(f.owner, packet('1234')), false, 'unrelated numbers outside a prompt remain normal agent input')
  for (const text of ['the code is 1234', 'the password is twelve thirty four', 'my password is do-not-forward']) {
    assert.equal(f.host.onVoice(f.owner, packet(text)), true, 'named codes/passwords stay local after the prompt is gone')
    assert.match(f.host.state(f.owner).last.message, /no matching confirmation/i)
    assert.ok(!f.host.state(f.owner).last.message.includes('do-not-forward'))
  }
})

test('unsupported desktop scopes refuse before consent, audit, or execution on Linux and macOS', () => {
  for (const platform of ['linux', 'darwin']) {
    const f = fixture({ platform })
    assert.throws(() => f.host.prepareEnable(f.owner, { sessionId: 's', scope: 'desktop', platform: 'win32' }),
      { code: 'ACCESSIBILITY_SCOPE_UNSUPPORTED' })
    assert.equal(f.host.state(f.owner).enabled, false)
    assert.equal(f.host.state(f.owner).pending, null)
    assert.deepEqual(f.audit, [])
    assert.equal(f.count(), 0)
    const scopes = f.host.status(f.principal).scopes
    assert.equal(scopes.find(row => row.id === 'application').supported, true)
    assert.equal(scopes.find(row => row.id === 'desktop').supported, false)
    assert.match(scopes.find(row => row.id === 'desktop').reason, /only on Windows/)
  }
})

test('generic voice enable chooses application control on Linux and preserves Windows desktop behavior', async () => {
  for (const platform of ['linux', 'win32']) {
    const f = fixture({ platform })
    if (platform === 'linux') f.setTier('standard')
    assert.equal(f.host.onVoice(f.owner, { type: 'transcript.final', sequence: 1, generation: 1,
      sessionId: 'voice', targetAgentId: 's', text: 'enable accessibility' }), true)
    assert.equal(f.host.state(f.owner).enabled, false)
    assert.ok(f.host.state(f.owner).pending)
    await f.host.confirm(f.owner, f.consent())
    assert.equal(f.host.state(f.owner).scope, platform === 'win32' ? 'desktop' : 'application')
    f.host.disable(f.owner)
  }
})

test('an explicit unsupported desktop voice request stays local and cannot become an enable request', () => {
  const f = fixture({ platform: 'linux' })
  assert.equal(f.host.onVoice(f.owner, { type: 'transcript.final', sequence: 1, generation: 1,
    sessionId: 'voice', targetAgentId: 's', text: 'enable desktop accessibility' }), true)
  const state = f.host.state(f.owner)
  assert.equal(state.enabled, false)
  assert.equal(state.pending, null)
  assert.equal(state.last.status, 'refused')
  assert.match(state.last.message, /only on Windows/)
  assert.deepEqual(f.audit, [])
})

test('desktop support still requires Unrestricted permission on Windows', async () => {
  const f = fixture({ platform: 'win32' })
  assert.equal(f.host.state(f.owner).scopes.find(row => row.id === 'desktop').supported, true)
  f.setTier('standard')
  assert.throws(() => f.host.prepareEnable(f.owner, { sessionId: 's', scope: 'desktop' }),
    { code: 'ACCESSIBILITY_PERMISSION_REQUIRED' })
  f.setTier('unrestricted')
  f.host.prepareEnable(f.owner, { sessionId: 's', scope: 'desktop' })
  assert.equal(f.host.state(f.owner).enabled, false)
  await f.host.confirm(f.owner, f.consent())
  assert.equal(f.host.state(f.owner).scope, 'desktop')
  f.host.disable(f.owner)
})
