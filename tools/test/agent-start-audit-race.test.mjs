import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createAgentCommandSurface, REQUIRED_DEPS } = require('../../shell/agent-command-surface.cjs')

// The real command surface, with synthetic audit/store/provider dependencies.
// A strict host seam models owner-host's unchanged fresh global revision guard.
function harness(change, stage = 'audit') {
  const org = { revision: 1, agents: [{ id: 'child', enabled: true, provider: 'codex', role: 'worker' }] }
  let roleRevision = 1
  const events = []
  const fail = (code, message = code) => { throw Object.assign(new Error(message), { code }) }
  const role = { id: 'worker', name: 'Worker', owns: 'Inspect fixture.', mustNot: 'Change user files.', handoff: 'Return evidence.', rules: [], revision: 1 }
  const deps = Object.fromEntries(Object.entries(REQUIRED_DEPS).map(([key, type]) => [key,
    type === 'function' ? () => undefined : type === 'object' ? {} : type === 'number' ? 128 : 'synthetic']))
  const mutate = () => { change?.({ org, role, setRoleRevision(value) { roleRevision = value } }); events.push(stage) }
  const host = { async startSession(request) {
    events.push('host-start')
    if (request.agentAuthority.expectedOrgRevision !== org.revision) fail('OWNER_HOST_SESSION_REFUSED')
    events.push('credential', 'provider')
    return { sessionId: request.sessionId }
  } }
  Object.assign(deps, {
    agentSessions: new Map(), AGENT_EFFORT_VALUES: [], dialog: { showOpenDialog() {} },
    parseAgentStart: value => structuredClone(value), agentIpcError: fail, rendererSafeAgentError: error => error,
    recordSpawnIntent: async () => { events.push('intent'); if (stage === 'audit') mutate(); return { sequence: 1, eventHash: 'synthetic' } },
    getAgentHost: async () => { if (stage === 'host') mutate(); return host },
    agentOrgRecord: {
      read: () => ({ ok: true, org: structuredClone(org), roles: [role] }),
      resolveRoleBinding(binding) {
        events.push('resolve')
        const agent = org.agents.find(entry => entry.id === binding.agentId)
        if (binding.expectedOrgRevision !== org.revision || binding.expectedRoleRevision !== roleRevision
          || !agent || agent.enabled !== true || agent.role !== binding.id) return { ok: false, code: 'MC_AGENT_ROLE_STALE' }
        return { ok: true, role: structuredClone(role), agent: { id: agent.id }, authority: { agentId: agent.id, provider: agent.provider,
          roleId: agent.role, expectedOrgRevision: org.revision, expectedRoleRevision: roleRevision } }
      },
    },
  })
  const surface = createAgentCommandSurface(deps)
  return { deps, events, host, run: (revision = 1) => surface.run('agent:start', { sessionId: 'race-child',
    roleBinding: { agentId: 'child', id: 'worker', expectedOrgRevision: revision, expectedRoleRevision: 1 } },
  { kind: 'window', owner: {}, mayWrite: true, label: 'synthetic window' }) }
}

for (const stage of ['audit', 'host']) {
  test(`sibling declaration during ${stage} preparation preserves a fresh exact start`, async () => {
    const f = harness(({ org }) => { org.revision++; org.agents.push({ id: 'sibling', enabled: true, provider: 'codex', role: 'worker' }) }, stage)
    await f.run()
    assert.equal(f.events.filter(event => event === 'provider').length, 1)
    assert.ok(f.events.indexOf('intent') < f.events.indexOf('credential'))
  })
  for (const [name, change] of [
    ['disabled', ({ org }) => { org.agents[0].enabled = false }],
    ['removed', ({ org }) => { org.agents = [] }],
    ['provider changed', ({ org }) => { org.agents[0].provider = 'gemini' }],
    ['role changed', ({ org }) => { org.agents[0].role = 'observer' }],
    ['role revised', ({ setRoleRevision }) => setRoleRevision(2)],
    ['same-revision role words changed', ({ role }) => { role.owns = 'Different work.' }],
    ['same-revision role capabilities changed', ({ role }) => { role.capabilities = { orgRoot: true } }],
  ]) test(`${name} during ${stage} refuses before credentials or provider`, async () => {
    const f = harness(state => { state.org.revision++; change(state) }, stage)
    await assert.rejects(f.run(), { code: 'MC_AGENT_ROLE_STALE' })
    assert.equal(f.events.includes('host-start'), false)
    assert.equal(f.events.includes('credential'), false)
    assert.equal(f.events.includes('provider'), false)
    assert.equal(f.deps.agentSessions.size, 0)
  })
}

test('a renderer revision already stale on arrival still refuses before audit', async () => {
  const f = harness()
  await assert.rejects(f.run(0), { code: 'MC_AGENT_ROLE_STALE' })
  assert.deepEqual(f.events, ['resolve'])
})

test('failed audit never refreshes, creates host, issues credentials or starts provider', async () => {
  const f = harness()
  f.deps.recordSpawnIntent = async () => { throw Object.assign(new Error('audit refused'), { code: 'AUDIT_REFUSED' }) }
  // Dependencies are captured at construction, so a separate surface is required.
  const surface = createAgentCommandSurface(f.deps)
  await assert.rejects(surface.run('agent:start', { sessionId: 'audit-refused',
    roleBinding: { agentId: 'child', id: 'worker', expectedOrgRevision: 1, expectedRoleRevision: 1 } },
  { kind: 'window', owner: {}, mayWrite: true, label: 'synthetic window' }), { code: 'AUDIT_REFUSED' })
  assert.deepEqual(f.events, ['resolve'])
})
