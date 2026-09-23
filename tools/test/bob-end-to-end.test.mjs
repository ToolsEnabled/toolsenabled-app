/* BOB'S APP-SIDE FACADE SEAM, NOT A WHOLE NETWORK END TO END.
 *
 * The owner's scenario: he has agents running on his own computers, sits down
 * at a friend's machine, signs in to the website, and drives his own machine --
 * everything the app can do, except nothing runs on the computer he is sitting
 * at.
 *
 * Every piece of that chain has its own suite. What none of them prove is that
 * the pieces MEET: the browser's window.mcAgent, the sealed tunnel, the
 * machine's facade, the shared command surface, and the real handler bodies.
 * Each seam has been broken at least once in exactly the way a unit test does
 * not see -- an option named relayOrigin that the client called relayUrl; a
 * relay helper named post that silently ate the account's post; a route written
 * /v1/org/read from the design's prose when the facade serves /v1/org. All
 * three passed their own tests and would have shipped a product where nobody
 * could sign in or reach a machine.
 *
 * So this drives one real app-side seam in one process:
 *   reproduced browser-binding contract -> direct HTTP over 127.0.0.1 ->
 *   real agent-facade -> real agent-command-surface -> injected handler deps
 * It does NOT execute the website's host-bridge.js, the composite bridge, the
 * relay shell/web client, account service, or real shell handler dependencies.
 * Their focused suites prove separate segments, but no collection of those
 * passes is the real two-machine staging proof. A pass here therefore proves
 * route/verb/body/refusal parity at this seam; it is not Bob acceptance.
 *
 * WHAT THIS WOULD CATCH that the unit suites do not: a route the binding calls
 * and the facade does not serve; a verb mismatch; a query key the facade
 * refuses; a refusal code that arrives in a shape refusalCode() cannot read;
 * and the web-drive switch failing to stop a write.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const { createAgentFacade } = require(join(ROOT, 'shell', 'agent-facade.cjs'))
const { createAgentCommandSurface } = require(join(ROOT, 'shell', 'agent-command-surface.cjs'))

/* The far end: what the real handler bodies call. Recorded so a test can prove
   a command reached its actual implementation rather than a route stub. */
function machineDeps(record) {
  const sessions = new Map()
  const noop = () => {}
  const answer = (name, value) => (...args) => { record.push({ name, args }); return value }
  /* ONE host object, handed back by both accessors. They are separate deps in
     the surface (one lazily starts the engine, one returns what is already
     running) and an earlier version of this file gave getAgentHost undefined --
     which the facade correctly turned into AGENT_FACADE_INTERNAL with the stack
     going only to the log. A stub that differs from the real wiring tests the
     stub. */
  const host = {
    startSession: answer('startSession', { sessionId: 's1', threadId: 't1', tier: 'luna', effort: 'medium', account: 'a' }),
    sendTurn: answer('sendTurn', { sessionId: 's1', threadId: 't1', turnId: 'turn-1' }),
    listModels: answer('listModels', { ok: true, models: ['gpt-5.6'] }),
    closeSession: answer('closeSession', { sessionId: 's1', closed: true }),
    onEvent: () => () => {},
  }
  return {
    agentSessions: sessions,
    currentAgentHost: () => host,
    getAgentHost: () => host,
    agentIpcError: (code) => { const e = new Error(code); e.code = code; throw e },
    agentPayload: (value, keys) => {
      const out = {}
      for (const k of keys || []) if (value && value[k] !== undefined) out[k] = value[k]
      return out
    },
    boundedAgentString: (v) => (typeof v === 'string' ? v : ''),
    parseAgentStart: (v) => ({ ...(v || {}) }),
    parseAgentSend: (v) => ({ sessionId: (v || {}).sessionId, text: (v || {}).text }),
    parseAgentSessionCommand: (v) => ({ sessionId: (v || {}).sessionId }),
    rendererSafeAgentError: (e) => e,
    spawnRecordAvailability: answer('spawnRecordAvailability', { ok: true }),
    spawnRecordHistory: answer('spawnRecordHistory', { ok: true, total: 2, entries: [{ sequence: 2, at: '2026-08-21T12:00:00.000Z', action: 'agent_session_start' }], verified: true }),
    usageRecordHistory: answer('usageRecordHistory', { ok: true, total: 0, entries: [], verified: true }),
    engineAvailability: answer('engineAvailability', { ok: true, code: 'AGENT_ENGINE_READY' }),
    ensureWorkspaceRoot: noop,
    chosenWorkspaceCwd: () => 'C:/workspace',
    readAgentConfinement: answer('readAgentConfinement', { ok: true, tier: 'luna', toolsAllowed: 4, toolsTotal: 12 }),
    listAgentTools: answer('listAgentTools', { ok: true, tier: 'luna', total: 12, tools: ['read'] }),
    resolveCapabilityRoot: () => ROOT,
    requireModule: () => ({}),
    readStandingRequests: answer('readStandingRequests', { ok: true, exists: false, entries: [] }),
    readCanonicalLedger: answer('readCanonicalLedger', { ok: true, revision: 0, updatedAt: null, exists: false, records: [], chain: { ok: true, events: 0, drift: [], unchained: [], code: null }, filter: { scope: 'all', key: null, removed: false } }),
    sessionProfiles: { resolveCwd: () => 'C:/workspace', list: () => [], remove: () => true },
    recordSpawnIntent: answer('recordSpawnIntent', { sequence: 1, eventHash: 'h' }),
    recordSpawnOutcome: noop,
    recordSessionEnd: noop,
    bindAgentOwner: noop,
    agentOrgRecord: {
      read: answer('orgRead', { ok: true, org: { revision: 1, agents: [] } }),
      reparent: answer('orgReparent', { ok: true }),
      exportOrg: answer('orgExport', { ok: true, org: {} }),
    },
    dialog: { showOpenDialog: () => { throw new Error('a dialog must never be reachable from the relay') } },
    MAX_AGENT_SESSIONS: 8,
    MAX_SESSION_ID_LENGTH: 64,
    AGENT_EFFORT_VALUES: ['low', 'medium', 'high'],
    WORKSPACE_ROOT: 'C:/workspace',
  }
}

/* The browser half, reproduced from host-bridge.js's contract rather than
   imported: that file is a website asset with no module exports, and the
   PROPERTY under test is the wire contract, not its source text. Its own
   parity suite pins the method list against the desktop preload. */
function browserBinding(origin, token) {
  const call = async (method, path, body) => {
    const response = await fetch(origin + path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    let value = null
    try { value = await response.json() } catch { value = null }
    if (response.status >= 200 && response.status < 300) return value
    const code = value?.error?.code || `HTTP_${response.status}`
    throw Object.assign(new Error(code), { code })
  }
  return {
    availability: () => call('GET', '/v1/agent/availability'),
    history: (r) => call('GET', `/v1/agent/history?limit=${(r || {}).limit ?? 20}`),
    start: (r) => call('POST', '/v1/agent/start', r || {}),
    send: (r) => call('POST', '/v1/agent/send', r || {}),
    orgRead: () => call('GET', '/v1/org'),
    pickAttachment: () => call('POST', '/v1/agent/pick-attachment', {}),
  }
}

async function standUp({ mayWrite }) {
  const record = []
  const surface = createAgentCommandSurface(machineDeps(record))
  /* mayWrite may be a function so a test can flip the switch between calls,
     the way the owner's switch is read per command in shell/main.cjs. */
  const facade = createAgentFacade({
    surface,
    principalForRelay: () => ({
      kind: 'relay',
      owner: 'relay-principal',
      mayWrite: typeof mayWrite === 'function' ? mayWrite() : mayWrite,
      label: 'web (relay)',
    }),
    log: (...parts) => {
      if (!process.env.BOB_E2E_DEBUG) return
      for (const part of parts) {
        console.error('FACADE-LOG:', part && part.stack ? part.stack.split('\n').slice(0, 4).join(' || ') : String(part))
      }
    },
  })
  const { origin, token } = await facade.listen()
  return { facade, origin, token, record, mcAgent: browserBinding(origin, token) }
}

test('signed in with web-drive ON: the browser reads and drives the machine', async () => {
  const bob = await standUp({ mayWrite: true })
  try {
    const availability = await bob.mcAgent.availability()
    assert.equal(availability.ok, true, 'availability did not reach the real handler')

    const history = await bob.mcAgent.history({ limit: 20 })
    assert.equal(history.total, 2, 'history did not come from the spawn record')

    const started = await bob.mcAgent.start({ tier: 'luna' })
    assert.deepEqual(started, {
      sessionId: 's1',
      threadId: 't1',
      tier: 'luna',
      effort: 'medium',
      account: 'a',
      record: { sequence: 1, eventHash: 'h' },
      audit: { sequence: 1, eventHash: 'h' },
    }, 'start dropped or rewrote a field returned by the real handler')
    assert.ok(bob.record.some(c => c.name === 'recordSpawnIntent'),
      'start never reached recordSpawnIntent -- the route answered without running the handler body')

    const org = await bob.mcAgent.orgRead()
    assert.equal(org.ok, true, 'GET /v1/org did not reach the org record')
  } finally { await bob.facade.close() }
})

test('web-drive OFF is the whole difference: reads answer, writes refuse', async () => {
  const bob = await standUp({ mayWrite: false })
  try {
    const availability = await bob.mcAgent.availability()
    assert.equal(availability.ok, true, 'a read was refused with the switch off; only writes should be')

    await assert.rejects(
      () => bob.mcAgent.start({ tier: 'luna' }),
      (error) => {
        assert.equal(error.code, 'MC_AGENT_PRINCIPAL_READ_ONLY',
          `a write with web-drive off refused as ${error.code}`)
        return true
      })

    assert.ok(!bob.record.some(c => c.name === 'recordSpawnIntent'),
      'the refusal happened AFTER the handler ran -- nothing may be recorded for a refused write')
  } finally { await bob.facade.close() }
})

/* THE SWITCH IS READ PER CALL, NOT CAPTURED AT CONNECT. The owner turns it
   off on the machine and the very next command from an already-connected
   browser is refused -- no relaunch, no new lease. This is what lets "turn it
   off" mean something while a tab is still open. */
test('turning the switch off between calls refuses the next write and still answers reads', async () => {
  let on = true
  const bob = await standUp({ mayWrite: () => on })
  try {
    const started = await bob.mcAgent.start({ tier: 'luna' })
    assert.ok(started.sessionId, 'start with the switch on returned no session')

    on = false
    await assert.rejects(
      () => bob.mcAgent.send({ sessionId: started.sessionId, text: 'hello' }),
      (error) => {
        assert.equal(error.code, 'MC_AGENT_PRINCIPAL_READ_ONLY',
          `a write after the switch went off refused as ${error.code}`)
        return true
      })
    const availability = await bob.mcAgent.availability()
    assert.equal(availability.ok, true, 'reads keep answering with the switch off')
  } finally { await bob.facade.close() }
})

/* THE ONE WAY A BROWSER MUST NEVER BE ABLE TO MOVE THE SWITCH. There is no
   prefs route on the facade; the switch is written only from the window on
   the machine, over mc-prefs:write. A route appearing here would let a stolen
   session grant itself the permission the switch exists to withhold. */
test('there is no route through the facade that could write a preference', async () => {
  const bob = await standUp({ mayWrite: true })
  try {
    for (const route of ['/v1/prefs/write', '/v1/prefs', '/v1/settings/write']) {
      const response = await fetch(bob.origin + route, {
        method: 'POST',
        headers: { authorization: `Bearer ${bob.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'mc.relay.web-drive', value: 'on' }),
      })
      assert.equal(response.status, 404, `${route} answered ${response.status}`)
      const body = await response.json()
      assert.equal(body.error.code, 'AGENT_FACADE_UNKNOWN_ROUTE')
    }
  } finally { await bob.facade.close() }
})

test('the friend\'s computer is never reached: dialogs are not routed at all', async () => {
  const bob = await standUp({ mayWrite: true })
  try {
    await assert.rejects(
      () => bob.mcAgent.pickAttachment(),
      (error) => {
        /* 404 from the route table, or the surface's own dialog refusal behind
           it. Either is correct; a dialog OPENING is not. */
        assert.match(error.code, /AGENT_FACADE_UNKNOWN_ROUTE|MC_AGENT_DIALOG_REQUIRES_WINDOW|HTTP_404/,
          `pick-attachment answered ${error.code}`)
        return true
      })
  } finally { await bob.facade.close() }
})

test('a browser cannot reach the facade directly, even with the token', async () => {
  const bob = await standUp({ mayWrite: true })
  try {
    const response = await fetch(bob.origin + '/v1/agent/availability', {
      headers: { authorization: `Bearer ${bob.token}`, origin: 'https://toolsenabled.ai' },
    })
    assert.equal(response.status, 403, 'a request carrying Origin was not refused')
    const body = await response.json()
    assert.equal(body.error.code, 'AGENT_FACADE_NO_BROWSERS')
  } finally { await bob.facade.close() }
})

test('no refusal carries a path, a stack, or internal prose to the browser', async () => {
  const bob = await standUp({ mayWrite: false })
  try {
    await bob.mcAgent.start({ tier: 'luna' }).then(
      () => assert.fail('the write should have refused'),
      (error) => {
        const text = String(error.code)
        assert.doesNotMatch(text, /[/\\]/, `a refusal code carried a path: ${text}`)
        assert.doesNotMatch(text, /\bat \w+/, `a refusal code carried a stack fragment: ${text}`)
        assert.match(text, /^[A-Z][A-Z0-9_]+$/, `a refusal must be a bounded code, got: ${text}`)
      })
  } finally { await bob.facade.close() }
})
