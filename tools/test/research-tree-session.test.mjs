import test from 'node:test'
import assert from 'node:assert/strict'
import { bindResearchTreeSession, withResearchTreeBinding } from '../../src/research-tree-session.js'

const projectId = 'rp-0123456789abcdef'
const sessionId = 'node-session-research'
const project = { projectId, name: 'Selected study', status: 'active', enabled: false }
const assignment = { assignmentId: 'ra-abcdef0123456789', kind: 'observed', ref: sessionId, disposition: 'assigned' }
const read = () => ({ ok: true, receipt: { projects: [project] } })
const receipt = () => ({ ok: true, receipt: { projectId, assigned: [assignment], unassigned: [] } })
const binding = () => ({ ok: true, context: 'Current project context', project })
const deferred = () => {
  let resolve
  const promise = new Promise(answer => { resolve = answer })
  return { promise, resolve }
}
function bridgeFixture(overrides = {}) {
  const calls = { starts: [], sends: [], closes: [] }
  const bridge = {
    async start(request) { calls.starts.push(request); return { sessionId, threadId: 'thread-1', roleIntroduction: 'Role directions' } },
    async send(request) { calls.sends.push(request); return { sessionId, turnId: 'turn-1' } },
    async close(request) { calls.closes.push(request); return { sessionId: request.sessionId, closed: true } },
    ...overrides,
  }
  return { bridge, calls }
}

test('binds the real observed session through the service and uses authoritative project data', async () => {
  const calls = []
  const result = await bindResearchTreeSession({
    projectId, sessionId, snapshot: async () => read(),
    postAction: async (action, body) => { calls.push({ action, body }); return receipt() },
  })
  assert.equal(result.ok, true)
  assert.equal(result.project.enabled, false, 'a disabled run pipeline does not disable project research')
  assert.deepEqual(calls, [{ action: 'research-session-assign', body: { projectId, assign: [{ kind: 'observed', ref: sessionId }] } }])
  assert.equal(result.assignment.assignmentId, assignment.assignmentId)
  assert.match(result.context, /research\.session_context/)
  assert.ok(result.context.includes(JSON.stringify({ refs: [{ kind: 'observed', ref: sessionId }] })))
  assert.ok(result.context.includes(JSON.stringify({ projectId, name: project.name })))
})

test('invalid identities, absent projects and archived projects never write assignments', async () => {
  let writes = 0
  const postAction = async () => { writes++; return receipt() }
  for (const input of [
    { projectId: 'all', sessionId, snapshot: async () => read() },
    { projectId, sessionId: 'bad\nref', snapshot: async () => read() },
    { projectId, sessionId, snapshot: async () => ({ ok: true, receipt: { projects: [] } }) },
    { projectId, sessionId, snapshot: async () => ({ ok: true, receipt: { projects: [{ ...project, status: 'archived' }] } }) },
    { projectId, sessionId, snapshot: async () => ({ ok: true, receipt: {} }) },
  ]) assert.equal((await bindResearchTreeSession({ ...input, postAction })).ok, false)
  assert.equal(writes, 0)
})

test('service refusal and missing answer stay refusals without browser pending fallback', async () => {
  for (const result of [null, { ok: false, code: 'BRIDGE_DOWN', reason: 'Disconnected' }, { ok: true, pending: true }]) {
    const value = await bindResearchTreeSession({ projectId, sessionId, snapshot: async () => read(), postAction: async () => result })
    assert.equal(value.ok, false)
  }
  const threw = await bindResearchTreeSession({ projectId, sessionId, snapshot: async () => { throw new Error('offline') } })
  assert.equal(threw.code, 'RESEARCH_SNAPSHOT_UNAVAILABLE')
})

test('only the exact confirmed project/session assignment receipt is accepted', async () => {
  const wrong = [
    { ok: true, receipt: { projectId: 'rp-deadbeef', assigned: [assignment] } },
    { ok: true, receipt: { projectId, assigned: [{ ...assignment, ref: 'another-session' }] } },
    { ok: true, receipt: { projectId, assigned: [{ ...assignment, kind: 'all' }] } },
    { ok: true, receipt: { projectId, assigned: [{ ...assignment, assignmentId: '' }] } },
    { ok: true, receipt: { projectId, assigned: [{ ...assignment, disposition: 'pending' }] } },
    { ...receipt(), pending: true },
  ]
  for (const value of wrong) {
    assert.equal((await bindResearchTreeSession({ projectId, sessionId, snapshot: async () => read(), postAction: async () => value })).ok, false)
  }
  const replay = receipt()
  replay.receipt.assigned = [{ ...assignment, disposition: 'replay' }]
  assert.equal((await bindResearchTreeSession({ projectId, sessionId, snapshot: async () => read(), postAction: async () => replay })).ok, true)
})

test('uses a captured computer destination for both reads and writes', async () => {
  const calls = []
  const destination = { ok: true, key: 'computer-A', request: async (action, body) => {
    calls.push({ action, body })
    return action === 'research-snapshot' ? read() : receipt()
  } }
  const result = await bindResearchTreeSession({
    projectId, sessionId, requireDestination: true, captureDestination: async () => destination,
    snapshot: async () => assert.fail('unscoped snapshot'), postAction: async () => assert.fail('unscoped write'),
  })
  assert.equal(result.ok, true)
  assert.deepEqual(calls.map(call => call.action), ['research-snapshot', 'research-session-assign'])
})

test('a computer switch during project read prevents the assignment write', async () => {
  let selected = 'A', writes = 0
  const request = async action => {
    if (action === 'research-snapshot') { selected = 'B'; return read() }
    writes++; return receipt()
  }
  const result = await bindResearchTreeSession({
    projectId, sessionId, requireDestination: true,
    captureDestination: async () => ({ ok: true, key: selected, request }),
  })
  assert.equal(result.code, 'RESEARCH_DESTINATION_UNAVAILABLE')
  assert.equal(writes, 0)
})

test('a computer switch while assigning cannot authorize the first turn', async () => {
  let selected = 'A'
  const request = async action => {
    if (action === 'research-snapshot') return read()
    selected = 'B'; return receipt()
  }
  const result = await bindResearchTreeSession({
    projectId, sessionId, requireDestination: true,
    captureDestination: async () => ({ ok: true, key: selected, request }),
  })
  assert.equal(result.code, 'RESEARCH_DESTINATION_UNAVAILABLE')
})

test('ordinary native start and send remain unchanged and do not bind research', async () => {
  const { bridge, calls } = bridgeFixture()
  const wrapped = withResearchTreeBinding(bridge, { bind: () => assert.fail('ordinary start must not bind') })
  const started = await wrapped.start({ tier: 'fast', surface: 'fleet-tree' })
  assert.equal(started.roleIntroduction, 'Role directions')
  await wrapped.send({ sessionId, text: 'Hello' })
  assert.deepEqual(calls.starts, [{ tier: 'fast', surface: 'fleet-tree' }])
  assert.deepEqual(calls.sends, [{ sessionId, text: 'Hello' }])
})

test('research start strips the extra IPC field and waits for membership before publishing', async () => {
  const gate = deferred()
  const { bridge, calls } = bridgeFixture()
  const wrapped = withResearchTreeBinding(bridge, { bind: async () => gate.promise })
  let published = false
  const started = wrapped.start({ sessionId, researchProjectId: projectId, resumeThreadId: 'old-thread', surface: 'fleet-tree' })
    .then(result => { published = true; return result })
  await Promise.resolve()
  assert.equal(published, false)
  assert.equal(Object.hasOwn(calls.starts[0], 'researchProjectId'), false)
  assert.equal(calls.starts[0].resumeThreadId, 'old-thread')
  assert.equal((await wrapped.send({ sessionId, text: 'premature' })).code, 'RESEARCH_ASSIGNMENT_PENDING')
  assert.equal(calls.sends.length, 0)
  gate.resolve(binding())
  const result = await started
  assert.equal(result.researchProject.projectId, projectId)
  assert.equal(result.roleIntroduction, 'Role directions\n\nCurrent project context')
  await wrapped.send({ sessionId, text: 'Continue' })
  await wrapped.send({ sessionId, text: 'Second message' })
  assert.deepEqual(calls.sends.map(call => call.text), ['Continue\n\nCurrent project context', 'Second message'])
})

test('a refused first send keeps its context for an accepted retry', async () => {
  const { bridge, calls } = bridgeFixture()
  bridge.send = async request => {
    calls.sends.push(request)
    return calls.sends.length === 1 ? { ok: false, code: 'AGENT_TURN_ACTIVE' } : { sessionId, turnId: 'turn-2' }
  }
  const wrapped = withResearchTreeBinding(bridge, { bind: async () => binding() })
  await wrapped.start({ researchProjectId: projectId })
  await wrapped.send({ sessionId, text: 'First' })
  await wrapped.send({ sessionId, text: 'Retry' })
  await wrapped.send({ sessionId, text: 'Next' })
  assert.deepEqual(calls.sends.map(call => call.text), ['First\n\nCurrent project context', 'Retry\n\nCurrent project context', 'Next'])
})

test('a thrown send keeps its context and concurrent first sends are not duplicated', async () => {
  const gate = deferred()
  const { bridge, calls } = bridgeFixture()
  bridge.send = async request => { calls.sends.push(request); return gate.promise }
  const wrapped = withResearchTreeBinding(bridge, { bind: async () => binding() })
  await wrapped.start({ researchProjectId: projectId })
  const first = wrapped.send({ sessionId, text: 'First' })
  assert.equal((await wrapped.send({ sessionId, text: 'Concurrent' })).code, 'AGENT_TURN_ACTIVE')
  assert.equal(calls.sends.length, 1)
  gate.resolve({ ok: false })
  await first
  bridge.send = async () => { throw new Error('refused') }
  await assert.rejects(wrapped.send({ sessionId, text: 'Throws' }))
  bridge.send = async request => { calls.sends.push(request); return { sessionId, turnId: 'turn-3' } }
  await wrapped.send({ sessionId, text: 'Retry' })
  assert.equal(calls.sends.at(-1).text, 'Retry\n\nCurrent project context')
})

test('binding refusal closes the unused native session and blocks every send through that wrapper', async () => {
  const { bridge, calls } = bridgeFixture()
  const wrapped = withResearchTreeBinding(bridge, { bind: async () => ({ ok: false, code: 'PROJECT_GONE', reason: 'Project missing' }) })
  const result = await wrapped.start({ researchProjectId: projectId })
  assert.equal(result.ok, false)
  assert.equal(result.sessionId, null)
  assert.equal(result.notStarted, true)
  assert.equal(result.code, 'PROJECT_GONE')
  assert.deepEqual(calls.closes, [{ sessionId }])
  assert.equal((await wrapped.send({ sessionId, text: 'Must not send' })).ok, false)
  assert.equal(calls.sends.length, 0)
})

test('cleanup failure returns and reports the exact real session as a reachable Stop target', async () => {
  const { bridge, calls } = bridgeFixture({ close: async () => { throw new Error('cannot close') } })
  const retained = []
  const wrapped = withResearchTreeBinding(bridge, {
    bind: async () => ({ ok: false, code: 'BRIDGE_DOWN', reason: 'Research disconnected' }),
    onCleanupRequired: value => retained.push(value),
  })
  const result = await wrapped.start({ researchProjectId: projectId })
  assert.equal(result.code, 'AGENT_SESSION_CLEANUP_FAILED')
  assert.equal(result.sessionId, sessionId)
  assert.equal(result.cleanupPending, true)
  assert.equal(result.researchCode, 'BRIDGE_DOWN')
  assert.equal(retained[0].sessionId, sessionId)
  assert.equal((await wrapped.send({ sessionId, text: 'Do not spend' })).ok, false)
  assert.equal(calls.sends.length, 0)
})

test('malformed binding success closes instead of publishing an unscoped session', async () => {
  const { bridge, calls } = bridgeFixture()
  const wrapped = withResearchTreeBinding(bridge, { bind: async () => ({ ok: true }) })
  const result = await wrapped.start({ researchProjectId: projectId })
  assert.equal(result.code, 'RESEARCH_ASSIGNMENT_RECEIPT_INVALID')
  assert.equal(calls.closes.length, 1)
})

test('ended and refused native starts never file a project assignment', async () => {
  for (const started of [{ sessionId, ended: true }, { ok: false, code: 'NO_START' }]) {
    const { bridge } = bridgeFixture({ start: async () => started })
    const wrapped = withResearchTreeBinding(bridge, { bind: async () => assert.fail('never bind') })
    assert.equal(await wrapped.start({ researchProjectId: projectId }), started)
  }
})

test('an unavailable selected computer prevents native start', async () => {
  const { bridge, calls } = bridgeFixture()
  const wrapped = withResearchTreeBinding(bridge, {
    requireDestination: true, captureDestination: async () => ({ ok: false }), bind: async () => binding(),
  })
  assert.equal((await wrapped.start({ researchProjectId: projectId })).code, 'RESEARCH_DESTINATION_UNAVAILABLE')
  assert.equal(calls.starts.length, 0)
})

test('first context and rejected retry survive rebuilt wrappers around the same native bridge', async () => {
  const { bridge, calls } = bridgeFixture()
  bridge.send = async request => {
    calls.sends.push(request)
    return calls.sends.length === 1 ? { ok: false, code: 'AGENT_TURN_ACTIVE' } : { sessionId, turnId: 'retry-turn' }
  }
  const startWrapper = withResearchTreeBinding(bridge, { bind: async () => binding() })
  await startWrapper.start({ researchProjectId: projectId })
  await withResearchTreeBinding(bridge).send({ sessionId, text: 'First' })
  await withResearchTreeBinding(bridge).send({ sessionId, text: 'Retry' })
  await withResearchTreeBinding(bridge).send({ sessionId, text: 'Next' })
  assert.deepEqual(calls.sends.map(call => call.text), [
    'First\n\nCurrent project context', 'Retry\n\nCurrent project context', 'Next',
  ])
})

test('the explicit native bindingScope joins otherwise unrelated retained-start wrappers', async () => {
  const { bridge, calls } = bridgeFixture()
  const retained = { ...bridge, start: request => bridge.start(request) }
  await withResearchTreeBinding(retained, { bindingScope: bridge, bind: async () => binding() })
    .start({ researchProjectId: projectId })
  await withResearchTreeBinding(bridge).send({ sessionId, text: 'Fresh restart first turn' })
  assert.equal(calls.sends[0].text, 'Fresh restart first turn\n\nCurrent project context')
})

test('another native bridge or another session never inherits pending project context', async () => {
  const first = bridgeFixture(), other = bridgeFixture()
  await withResearchTreeBinding(first.bridge, { bind: async () => binding() }).start({ researchProjectId: projectId })
  await withResearchTreeBinding(other.bridge).send({ sessionId, text: 'Other computer same session id' })
  await withResearchTreeBinding(first.bridge).send({ sessionId: 'another-session', text: 'Another local session' })
  assert.equal(other.calls.sends[0].text, 'Other computer same session id')
  assert.equal(first.calls.sends[0].text, 'Another local session')
  await withResearchTreeBinding(first.bridge).send({ sessionId, text: 'Actual session' })
  assert.equal(first.calls.sends[1].text, 'Actual session\n\nCurrent project context')
})

test('confirmed close through a different wrapper removes shared pending context', async () => {
  const { bridge, calls } = bridgeFixture()
  await withResearchTreeBinding(bridge, { bind: async () => binding() }).start({ researchProjectId: projectId })
  await withResearchTreeBinding(bridge).close({ sessionId })
  // The host will normally refuse this now-closed id. The stub records only
  // whether the renderer retained context after confirmed cleanup.
  await withResearchTreeBinding(bridge).send({ sessionId, text: 'No retained project context' })
  assert.equal(calls.sends[0].text, 'No retained project context')
})

test('ok:false with closed:true is not confirmation and preserves the Stop target', async () => {
  const { bridge, calls } = bridgeFixture({
    close: async request => ({ ok: false, sessionId: request.sessionId, closed: true }),
  })
  const retained = []
  const wrapped = withResearchTreeBinding(bridge, {
    bind: async () => ({ ok: false, code: 'BRIDGE_DOWN', reason: 'No assignment receipt' }),
    onCleanupRequired: value => retained.push(value),
  })
  const failed = await wrapped.start({ researchProjectId: projectId })
  assert.equal(failed.code, 'AGENT_SESSION_CLEANUP_FAILED')
  assert.equal(failed.cleanupPending, true)
  assert.equal(retained[0].sessionId, sessionId)
  const retryWrapper = withResearchTreeBinding(bridge)
  await retryWrapper.close({ sessionId })
  assert.equal((await retryWrapper.send({ sessionId, text: 'Still blocked' })).ok, false)
  assert.equal(calls.sends.length, 0)
})

test('a confirmed close while binding is in flight cannot resurrect a published session', async () => {
  const gate = deferred()
  const { bridge, calls } = bridgeFixture()
  const start = withResearchTreeBinding(bridge, { bind: () => gate.promise }).start({ researchProjectId: projectId })
  await Promise.resolve()
  await withResearchTreeBinding(bridge).close({ sessionId })
  gate.resolve(binding())
  const result = await start
  assert.equal(result.code, 'RESEARCH_SESSION_CLOSED')
  assert.equal(result.sessionId, null)
  assert.equal(calls.sends.length, 0)
})

test('the shared context store refuses overflow without evicting unsent context and frees closed rows', async () => {
  let nextId = 0
  const calls = []
  const bridge = {
    async start() { return { sessionId: 'pending-' + (++nextId) } },
    async send(request) { calls.push(request); return { sessionId: request.sessionId, turnId: 'accepted' } },
    async close(request) { return { sessionId: request.sessionId, closed: true } },
  }
  const wrapped = withResearchTreeBinding(bridge, { bind: async () => binding() })
  for (let index = 0; index < 4096; index++) {
    assert.equal((await wrapped.start({ researchProjectId: projectId })).sessionId, 'pending-' + (index + 1))
  }
  assert.equal((await withResearchTreeBinding(bridge, { bind: async () => binding() }).start({ researchProjectId: projectId })).code,
    'RESEARCH_ASSIGNMENTS_BUSY')
  assert.equal(nextId, 4096, 'overflow does not start another native session')
  await withResearchTreeBinding(bridge).send({ sessionId: 'pending-1', text: 'Oldest still has context' })
  assert.equal(calls[0].text, 'Oldest still has context\n\nCurrent project context')
  await withResearchTreeBinding(bridge).close({ sessionId: 'pending-2' })
  assert.equal((await wrapped.start({ researchProjectId: projectId })).sessionId, 'pending-4097')
})


test('restricted children receive selected inputs without automatic project membership or context', async () => {
  for (const mode of ['folder', 'clean-room']) {
    const { bridge, calls } = bridgeFixture()
    const wrapped = withResearchTreeBinding(bridge, {
      requireDestination: true,
      captureDestination: async () => assert.fail('restricted child must not read the parent project destination'),
      bind: async () => assert.fail('restricted child must not inherit project content'),
    })
    const research = { mode, access: 'read-only', prompt: 'Only this selected task.',
      ...(mode === 'folder' ? { folder: '/selected' } : { files: [{ path: 'sample.txt', content: 'explicit input' }] }) }
    await wrapped.start({ sessionId, researchProjectId: projectId, research })
    await withResearchTreeBinding(bridge).send({ sessionId, text: research.prompt })
    assert.deepEqual(calls.starts, [{ sessionId, research }])
    assert.deepEqual(calls.sends, [{ sessionId, text: research.prompt }])
  }
})
