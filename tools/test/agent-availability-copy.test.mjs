import test from 'node:test'
import assert from 'node:assert/strict'

import {
  providerSignInReading,
  refusalAttribution,
  refusalCode,
  unavailableReason,
} from '../../src/agent-availability-copy.js'

test('keystore refusal copy identifies unavailable protection without guessing platform or credential failure', () => {
  for (const code of ['SPAWN_RECORD_NO_KEYSTORE', 'SPAWN_RECORD_KEYSTORE_UNAVAILABLE']) {
    const reason = unavailableReason(code)
    assert.match(reason, /secure key storage/)
    assert.match(reason, /will not start an agent|cannot be recorded does not happen/)
    assert.doesNotMatch(reason, /Windows|Linux|macOS|password|locked|denied/i)
    assert.equal(refusalCode({ code }), code)
  }
})

test('provider presence distinguishes a usable sign-in from a proven Codex sign-out', () => {
  // Mutation observed red: remove the installed === 'yes' condition from anySignedIn.
  const signedIn = providerSignInReading({
    ok: true,
    providers: [
      { id: 'codex', installed: 'yes', signedIn: 'no' },
      { id: 'claude', installed: 'yes', signedIn: 'yes' },
    ],
  })
  assert.deepEqual(signedIn, {
    known: true,
    anySignedIn: true,
    codexSignedOut: true,
  }, 'an installed, signed-in real provider enables the positive reading while Codex retains its actionable sign-out reason')

  const unavailable = providerSignInReading({
    ok: true,
    providers: [{ id: 'codex', installed: 'yes', signedIn: 'no' }],
  })
  assert.deepEqual(unavailable, {
    known: true,
    anySignedIn: false,
    codexSignedOut: true,
  }, 'a control that cannot use Codex must be negative and carry the specific signed-out reason')

  assert.equal(providerSignInReading({
    ok: true,
    providers: [{ id: 'claude', installed: 'no', signedIn: 'yes' }],
  }).anySignedIn, false, 'a stale sign-in claim cannot enable an unavailable provider')
})

test('a failed or unreadable provider request remains unknown rather than becoming a definite no', () => {
  // Mutation observed red: change the unknown reading's known field to true.
  for (const reply of [null, { ok: false, code: 'BRIDGE_TIMEOUT' }, { ok: true }, { ok: true, providers: [] }]) {
    assert.deepEqual(providerSignInReading(reply), {
      known: false,
      anySignedIn: false,
      codexSignedOut: false,
    }, 'could-not-read provider presence must not collapse into a definite availability answer')
  }
})

test('availability failures give a reason without exposing unknown boundary text', () => {
  // Mutation observed red: return String(code) for an unknown availability code.
  const known = unavailableReason('BRIDGE_TIMEOUT')
  assert.match(known, /did not answer in time/i, 'a known failure must retain its specific human reason')

  const unknown = unavailableReason('C:\\Users\\person\\secret.txt')
  assert.match(unknown, /could not work out why/i, 'an unknown failure must admit that its reason could not be read')
  assert.doesNotMatch(unknown, /secret\.txt|C:\\Users/i, 'untrusted boundary text must not become customer-facing copy')
})

test('IPC refusal recovery accepts known product codes and rejects message lookalikes', () => {
  // Mutation observed red: return the first code-shaped message token without checking the copy table.
  assert.equal(
    refusalCode(new Error('Error invoking remote method: MC_AGENT_SESSION_LIMIT')),
    'MC_AGENT_SESSION_LIMIT',
    'a real IPC caller must recover the product refusal code embedded by Electron',
  )
  assert.equal(
    refusalCode(new Error('C:\\PRIVATE_PATH\\CUSTOM_FAILURE happened')),
    'AGENT_SESSION_FAILED',
    'an unknown code-shaped message must resolve to the named safe fallback, not attacker-controlled text',
  )
})


test('an unsupported Gemini client is distinguished from missing sign-in', () => {
  const reason = unavailableReason('ACP_CLIENT_UNSUPPORTED')
  assert.match(reason, /Google.*no longer supports.*client.*account/)
  assert.doesNotMatch(reason, /sign.in|password|install Gemini|retry/i)
  assert.notEqual(reason, unavailableReason('ACP_AUTH_REQUIRED'))
})

test('unavailable or unconfirmed ACP selections explain what the person can change', () => {
  for (const code of ['ACP_MODEL_UNAVAILABLE', 'ACP_MODEL_SELECTION_UNCONFIRMED']) {
    assert.match(unavailableReason(code), /model.*Choose.*model/)
  }
  for (const code of ['ACP_EFFORT_UNAVAILABLE', 'ACP_EFFORT_SELECTION_UNCONFIRMED']) {
    assert.match(unavailableReason(code), /effort.*Choose.*effort/)
  }
})

test('Stop cleanup remains a named refusal after IPC strips custom error properties', () => {
  assert.equal(refusalCode(new Error("Error invoking remote method 'agent:interrupt': Error: AGENT_STOP_PENDING")), 'AGENT_STOP_PENDING')
  assert.match(unavailableReason('AGENT_STOP_PENDING'), /not finished stopping/)
})

/* WHICH LIMIT REFUSED A RESUME -- ABSENT FIRST, BECAUSE ABSENT IS THE CASE THAT
 * WILL ROT. An older host says nothing, and a probe predating the field says
 * nothing; both must read as "nobody said", never as the provider. A caller that
 * continues a conversation automatically acts only on a positive answer, so a
 * default here would be the one mistake that moves somebody off their own
 * conversation on a guess. */
test('an unattributed resume limit reads as nobody-said, never as the provider', () => {
  // The wire form from a host that does not carry the field at all.
  assert.equal(refusalAttribution(new Error('AGENT_RESUME_ACCOUNT_LIMIT')), null)
  // And through the real IPC wrapper, which is how a window actually sees it.
  assert.equal(refusalAttribution(new Error("Error invoking remote method 'agent:start': Error: AGENT_RESUME_ACCOUNT_LIMIT")), null)
  for (const error of [null, undefined, {}, new Error(''), { message: 42 }, { exhaustedBy: 'PROVIDER' }, { exhaustedBy: true }]) {
    assert.equal(refusalAttribution(error), null)
  }
  /* PROSE IS NOT A CONTRACT, and this is the whole reason the field exists: the
     sentence shown for this refusal says the provider refused the account, and
     reading THAT is what left recovery switched off for the life of the feature. */
  assert.equal(refusalAttribution(new Error('the provider has refused the account that owns this saved conversation: its allowance is spent')), null)
})

test('a measured resume limit names the limit that refused, and the refusal code is unchanged either way', () => {
  for (const [token, expected] of [['ATTRIBUTED_TO_PROVIDER', 'provider'], ['ATTRIBUTED_TO_CONFIGURED_LIMIT', 'configured']]) {
    const wire = new Error(token + ' AGENT_RESUME_ACCOUNT_LIMIT')
    assert.equal(refusalAttribution(wire), expected)
    /* THE REFUSAL A WINDOW READS MUST NOT MOVE. Two readers in the windows take
       the LAST code-shaped token as the refusal, so the code stays last and the
       attribution goes first; refusalCode takes the first KNOWN refusal, and an
       attribution token is not one. Both orders are asserted here rather than
       assumed, because getting it wrong would silently relabel every refusal. */
    assert.equal(refusalCode(wire), 'AGENT_RESUME_ACCOUNT_LIMIT')
    const lastToken = (wire.message.match(/[A-Z][A-Z0-9_]{2,63}/g) || []).at(-1)
    assert.equal(lastToken, 'AGENT_RESUME_ACCOUNT_LIMIT')
    // Through the wrapper a window really receives.
    const wrapped = new Error("Error invoking remote method 'agent:start': Error: " + token + ' AGENT_RESUME_ACCOUNT_LIMIT')
    assert.equal(refusalAttribution(wrapped), expected)
    assert.equal(refusalCode(wrapped), 'AGENT_RESUME_ACCOUNT_LIMIT')
  }
  // An in-process caller reads the named field directly, without parsing.
  assert.equal(refusalAttribution({ code: 'AGENT_RESUME_ACCOUNT_LIMIT', exhaustedBy: 'provider' }), 'provider')
})

/* THE WIRE AND THE READER, TESTED AS ONE PAIR.
 *
 * The tests above build wire forms by hand, so on their own they would stay green
 * if the host STOPPED SENDING the attribution. This runs shell/main.cjs's own
 * rendererSafeAgentError -- sliced out and executed, the way the other main.cjs
 * helpers are covered -- and reads its output with the real reader. Break either
 * end and this fails. */
test('the host wire form and the window reader agree, and say nothing when there is nothing to say', async () => {
  const { readFileSync } = await import('node:fs')
  const vm = await import('node:vm')
  const { fileURLToPath } = await import('node:url')
  const path = await import('node:path')
  const here = path.dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(path.join(here, '..', '..', 'shell', 'main.cjs'), 'utf8')
  const from = source.indexOf('const AGENT_REFUSAL_ATTRIBUTION_TOKENS')
  const to = source.indexOf('function agentPayload')
  assert.ok(from > 0 && to > from, 'the wire helper must still be findable in shell/main.cjs')
  const context = { Object }
  vm.runInNewContext(source.slice(from, to) + '; this.rendererSafeAgentError = rendererSafeAgentError', context)
  const wire = context.rendererSafeAgentError

  // ABSENT FIRST: a refusal with nothing measured must cross with nothing added.
  const silent = wire({ code: 'AGENT_RESUME_ACCOUNT_LIMIT' })
  assert.equal(refusalAttribution(silent), null)
  assert.equal(refusalCode(silent), 'AGENT_RESUME_ACCOUNT_LIMIT')
  assert.equal(silent.message, 'AGENT_RESUME_ACCOUNT_LIMIT')

  // MEASURED: the fact crosses verbatim and the refusal still reads the same.
  for (const [exhaustedBy, expected] of [['provider', 'provider'], ['configured', 'configured']]) {
    const crossed = wire({ code: 'AGENT_RESUME_ACCOUNT_LIMIT', exhaustedBy })
    assert.equal(refusalAttribution(crossed), expected)
    assert.equal(refusalCode(crossed), 'AGENT_RESUME_ACCOUNT_LIMIT')
    // The code stays LAST, for the two window readers that take the last token.
    assert.equal((crossed.message.match(/[A-Z][A-Z0-9_]{2,63}/g) || []).at(-1), 'AGENT_RESUME_ACCOUNT_LIMIT')
  }

  // A value the contract does not name is not forwarded, and the message stays clean.
  const junk = wire({ code: 'AGENT_RESUME_ACCOUNT_LIMIT', exhaustedBy: 'something-else' })
  assert.equal(refusalAttribution(junk), null)
  assert.equal(junk.message, 'AGENT_RESUME_ACCOUNT_LIMIT')
  // And the message never carries a credential or a path, whatever arrives.
  const hostile = wire({ code: 'AGENT_RESUME_ACCOUNT_LIMIT', exhaustedBy: 'provider', home: 'C:\Users\someone\.claude', token: 'secret' })
  assert.equal(hostile.message, 'ATTRIBUTED_TO_PROVIDER AGENT_RESUME_ACCOUNT_LIMIT')
  assert.equal('home' in hostile, false)
  assert.equal('token' in hostile, false)
})

test('standalone model-switch refusals survive the actual IPC wrapper with specific session and Home copy', async () => {
  const { readFileSync } = await import('node:fs')
  const vm = await import('node:vm')
  const { readAgentEngine, ENGINE_REASON } = await import('../../src/local-activity.js')
  const source = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
  const from = source.indexOf('const AGENT_REFUSAL_ATTRIBUTION_TOKENS')
  const to = source.indexOf('function agentPayload')
  assert.ok(from > 0 && to > from)
  const context = { Object }
  vm.runInNewContext(source.slice(from, to) + '; this.wire = rendererSafeAgentError', context)
  for (const code of ["AGENT_SWITCH_STALE","AGENT_SWITCH_ACCOUNT_UNAVAILABLE","AGENT_SWITCH_NOT_STANDALONE","AGENT_SWITCH_ACCOUNT_INVALID","AGENT_SWITCH_HISTORY_UNAVAILABLE","AGENT_SWITCH_CLEANUP_REQUIRED"]) {
    const wire = context.wire({ code, message: 'untrusted detail', token: 'private-token' })
    assert.equal(wire.message, code)
    const crossed = new Error('Error invoking remote method: Error: ' + wire.message)
    assert.equal(Object.hasOwn(crossed, 'code'), false, 'the Electron error message has no custom code property')
    assert.equal(refusalCode(crossed), code, code + ' must survive the IPC message boundary')
    const session = unavailableReason(code)
    const home = readAgentEngine({ ok: false, code })
    assert.match(session, /conversation|model|session/)
    assert.equal(home.ready, false)
    assert.equal(home.why, ENGINE_REASON[code])
    assert.ok(home.why && home.why.length > 20, code + ' needs specific Home copy')
    for (const sentence of [session, home.why]) {
      assert.doesNotMatch(sentence, /AGENT_[A-Z_]+|private-token|untrusted detail|could not work out why|not set up to run agents/)
    }
  }
  assert.match(unavailableReason('AGENT_SWITCH_CLEANUP_REQUIRED'), /could not confirm/)
  assert.doesNotMatch(unavailableReason('AGENT_SWITCH_CLEANUP_REQUIRED'), /nothing was started|nothing was changed|original.*retained/i)
})

test('all literal host model-switch refusals are classified after readiness without changing admission', async () => {
  const { readFileSync } = await import('node:fs')
  const vm = await import('node:vm')
  const source = readFileSync(new URL('../../shell/agent-host.cjs', import.meta.url), 'utf8')
  const readVocabulary = name => {
    const prefix = 'const ' + name + ' = Object.freeze(['
    const from = source.indexOf(prefix)
    const to = source.indexOf('])', from)
    assert.ok(from > 0 && to > from)
    return vm.runInNewContext(source.slice(from, to + 2) + '; Array.from(' + name + ')')
  }
  const availability = readVocabulary('AVAILABILITY_CODES')
  const afterReadiness = readVocabulary('START_REFUSAL_CODES')
  const raised = new Set([...source.matchAll(/\bfail\(\s*'(?<code>AGENT_SWITCH_[A-Z_]+)'/g)].map(match => match.groups.code))
  assert.deepEqual([...raised].sort(), ["AGENT_SWITCH_ACCOUNT_INVALID","AGENT_SWITCH_ACCOUNT_UNAVAILABLE","AGENT_SWITCH_CLEANUP_REQUIRED","AGENT_SWITCH_HISTORY_UNAVAILABLE","AGENT_SWITCH_NOT_STANDALONE","AGENT_SWITCH_STALE"])
  for (const code of raised) {
    assert.equal(availability.includes(code), false, code + ' requires a specific replacement operation')
    assert.equal(afterReadiness.filter(candidate => candidate === code).length, 1, code + ' needs exactly one copy classification')
  }
})

async function refusalHostSources() {
  const { readFileSync } = await import('node:fs')
  const { parseAst } = await import('rollup/parseAst')
  const vm = await import('node:vm')
  const source = readFileSync(new URL('../../shell/agent-host.cjs', import.meta.url), 'utf8')
  const nodes = new Map()
  const visit = node => {
    if (!node || typeof node !== 'object') return
    if (['FunctionDeclaration', 'ClassDeclaration'].includes(node.type) && node.id) nodes.set(node.id.name, node)
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object') visit(value)
    }
  }
  visit(parseAst(source))
  const declaration = name => {
    assert.ok(nodes.has(name), 'actual host declaration: ' + name)
    const node = nodes.get(name)
    return source.slice(node.start, node.end)
  }
  const main = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
  const from = main.indexOf('const AGENT_REFUSAL_ATTRIBUTION_TOKENS')
  const to = main.indexOf('function agentPayload')
  assert.ok(from > 0 && to > from)
  const wire = vm.runInNewContext(main.slice(from, to) + '; rendererSafeAgentError', { Error, Object })
  const crossed = error => {
    const sent = wire(error)
    const result = new Error('Error invoking remote method: Error: ' + sent.message)
    assert.equal(Object.hasOwn(result, 'code'), false)
    return result
  }
  return { source, nodes, declaration, crossed, compile(names, context) {
    return vm.runInNewContext(names.map(declaration).join('\n') + '\n; ({' + names.filter(name => name !== 'AgentHostError').join(',') + '})', context)
  }, vm }
}

test('image refusal uses the actual host entry and safe session/Home copy before any turn dispatch', async () => {
  const h = await refusalHostSources()
  const { readAgentEngine } = await import('../../src/local-activity.js')
  const { default: providerImageSupport } = await import('../../shell/provider-image-support.cjs')
  const session = { sessionId: 'copy-image', provider: 'local' }
  const send = h.nodes.get('sendTurn')
  const boundary = send.body.body.find(node => node.type === 'VariableDeclaration'
    && node.declarations.some(declaration => declaration.id.name === 'turnOptions'))
  assert.ok(boundary, 'entry validation must precede option narrowing and provider dispatch')
  const context = { Error, Object, assertOpen() {}, readySession(id) { assert.equal(id, session.sessionId); return session },
    providerImageSupport, parseCloudCommand: () => null }
  const entry = h.vm.runInNewContext(['AgentHostError', 'fail', 'boundedString', 'boundedTurnImages'].map(h.declaration).join('\n')
    + '\n(' + h.source.slice(send.start, send.body.start + 1) + h.source.slice(send.body.start + 1, boundary.start)
    + '\nreturn { turnText, turnImages, pictureNotSent }\n})', context)
  const request = { sessionId: session.sessionId, text: 'keep this text', images: [{ path: '/inert/one.png' }], origin: 'person' }
  let refusal
  await assert.rejects(entry(request), error => { refusal = error; return error.code === 'AGENT_IMAGE_UNSUPPORTED' })
  const recovered = refusalCode(h.crossed(refusal))
  assert.equal(recovered, 'AGENT_IMAGE_UNSUPPORTED')
  assert.match(unavailableReason(recovered), /cannot receive images.*Choose.*remove/)
  assert.match(readAgentEngine({ ok: false, code: recovered }).why, /cannot receive images.*Choose.*remove/)
  assert.equal(request.text, 'keep this text')
  assert.deepEqual(request.images, [{ path: '/inert/one.png' }])
  session.provider = 'codex'
  const acceptedEntry = await entry(request)
  assert.equal(acceptedEntry.turnText, request.text)
  assert.equal(acceptedEntry.turnImages[0].path, request.images[0].path)
  assert.equal(acceptedEntry.pictureNotSent, null)
})

test('actual Stop refusal retains captured custody and copy until a positively settled Stop', async () => {
  const h = await refusalHostSources()
  const { readAgentEngine } = await import('../../src/local-activity.js')
  let release
  const end = new Promise(resolve => { release = resolve })
  let interrupted = 0, releaseWaits = 0
  const adapter = { interrupt: async () => { interrupted++; return {} } }
  const announced = { completedTurnIds: new Set() }
  let session = { sessionId: 'copy-stop', threadId: 'thread', adapter, activeTurnId: 'turn',
    turnAnnounce: announced, sendPromise: Promise.resolve({ turnId: 'turn' }) }
  const stale = { turnId: 'turn', threadId: 'old-thread', adapter, providerDone: false }
  session.interruptState = stale
  const context = { Error, Object, Promise, AggregateError, sessionGoal: { GOAL_RUNNING_STATUSES: [] },
    assertOpen() {}, readySession(id, captured) { assert.equal(id, session.sessionId); if (captured) assert.equal(captured, session); return session },
    continuation: null, credentialBindingOf: () => null, authorityCancelWork: null,
    waitForInterruptProgress: promise => promise,
    waitForTurnRelease: async () => { releaseWaits++; await end } }
  const control = h.compile(['AgentHostError', 'fail', 'interruptTurnCompleted', 'interrupt'], context)
  let refusal
  await assert.rejects(control.interrupt({ sessionId: session.sessionId }), error => { refusal = error; return error.code === 'AGENT_STOP_PENDING' })
  assert.equal(session.interruptState, stale)
  assert.equal(session.interruptRequested, true)
  assert.equal(session.interruptPromise, null)
  assert.equal(interrupted, 0)
  assert.equal(releaseWaits, 0)
  const code = refusalCode(h.crossed(refusal))
  assert.equal(code, 'AGENT_STOP_PENDING')
  assert.equal(unavailableReason(code), 'the agent has not finished stopping. Retry Halt before sending more work, or close the session')
  assert.match(readAgentEngine({ ok: false, code }).why, /not finished stopping.*Retry Halt/)
  // A separate settled control starts with current ownership. No timeout or
  // cancellation receipt is manufactured into a terminal observation.
  const refusedSession = session
  session = { sessionId: 'copy-stop-settled', threadId: 'thread', adapter, activeTurnId: 'turn',
    turnAnnounce: announced, sendPromise: Promise.resolve({ turnId: 'turn' }) }
  let settled = false
  const stopping = control.interrupt({ sessionId: session.sessionId }).then(value => { settled = true; return value })
  for (let i = 0; i < 20 && releaseWaits === 0; i++) await Promise.resolve()
  assert.equal(interrupted, 1)
  assert.equal(releaseWaits, 1)
  assert.equal(settled, false)
  assert.equal(session.interruptRequested, true)
  announced.completedTurnIds.add('turn')
  session.activeTurnId = null
  release()
  const result = await stopping
  assert.equal(result.turnId, 'turn')
  assert.equal(session.interruptRequested, false)
  assert.equal(session.interruptState, null)
  assert.equal(refusedSession.interruptState, stale)
  assert.equal(refusedSession.interruptRequested, true)
})

test('image, mode and Stop refusals are operation-only classifications with specific session/Home copy', async () => {
  const h = await refusalHostSources()
  const { readAgentEngine } = await import('../../src/local-activity.js')
  const vocabulary = name => {
    const start = h.source.indexOf('const ' + name + ' = Object.freeze([')
    const end = h.source.indexOf('])', start)
    assert.ok(start > 0 && end > start)
    return h.vm.runInNewContext(h.source.slice(start, end + 2) + '; Array.from(' + name + ')')
  }
  const availability = vocabulary('AVAILABILITY_CODES')
  const operation = vocabulary('START_REFUSAL_CODES')
  for (const code of ['AGENT_IMAGE_UNSUPPORTED', 'AGENT_MODE_UNAVAILABLE', 'AGENT_MODE_SELECTION_UNCONFIRMED', 'AGENT_STOP_PENDING']) {
    assert.equal(availability.includes(code), false)
    assert.equal(operation.filter(value => value === code).length, 1, code + ' must be classified once')
    const recovered = refusalCode(h.crossed({ code, message: 'private detail' }))
    assert.equal(recovered, code)
    const home = readAgentEngine({ ok: false, code: recovered })
    assert.equal(home.ready, false)
    for (const sentence of [unavailableReason(recovered), home.why]) {
      assert.ok(sentence.length > 40)
      assert.doesNotMatch(sentence, /AGENT_[A-Z_]+|private detail|could not work out why|not set up to run agents/)
    }
  }
})

test('unsupported Optimized selection keeps its refusal through IPC and explains the retained setting', async () => {
  const { engineReason } = await import('../../src/local-activity.js')
  const code = 'AGENT_OPTIMIZED_TOOLS_UNSUPPORTED'
  const crossed = new Error("Error invoking remote method 'agent:start': Error: " + code)
  assert.equal(refusalCode(crossed), code)
  for (const platform of ['linux', 'win32']) {
    for (const sentence of [unavailableReason(refusalCode(crossed), { platform }), engineReason(code, { platform })]) {
      assert.match(sentence, /^Optimized works with Claude only, so this assistant was not started\. /)
      assert.match(sentence, /saved tool setting is unchanged/i)
      assert.match(sentence, /Start it with a Claude account, or choose Only, Enabled or Disabled for Agent API in quick settings, then retry$/)
      assert.doesNotMatch(sentence, /AGENT_OPTIMIZED_TOOLS_UNSUPPORTED|automatically|switched to Enabled/)
    }
  }
})

// T1503: on Linux and macOS the install steps were joined with a space, so
// "run: npm install -g @openai/codex" ran straight into "If Node.js or npm is
// missing" in the first thing a new customer reads on Home.
test('Linux and macOS Codex setup sentences set every command apart from the next sentence', async () => {
  const { AVAILABILITY_SUBJECT_REMOTE } = await import('../../src/agent-availability-copy.js')
  const codes = ['AGENT_CODEX_CLI_NOT_INSTALLED', 'AGENT_CONFINEMENT_SIGNED_OUT', 'CODEX_CLI_NOT_FOUND', 'CODEX_PROTOCOL_VERSION_MISMATCH']
  for (const platform of ['linux', 'darwin']) {
    for (const subject of [undefined, AVAILABILITY_SUBJECT_REMOTE]) {
      for (const code of codes) {
        const text = unavailableReason(code, { platform, ...(subject ? { subject } : {}) })
        assert.match(text, /run "npm install -g @openai\/codex"\./, `${platform} ${code}: the install command is quoted and ends its sentence: ${text}`)
        assert.doesNotMatch(text, /@openai\/codex [A-Z]/, `${platform} ${code}: the command runs into the next sentence: ${text}`)
        assert.doesNotMatch(text, /run: /, `${platform} ${code}: a bare command is left in the joined text: ${text}`)
        assert.doesNotMatch(text, /, [A-Z][a-z]+ (?:a terminal|that computer)/, `${platform} ${code}: a joined step keeps its capital mid-sentence: ${text}`)
      }
    }
    assert.equal(unavailableReason('AGENT_CONFINEMENT_SIGNED_OUT', { platform }),
      'This session needs a Codex sign-in on this computer. If Codex is installed, open a terminal and run "codex login". If it is missing, open a terminal. With Node.js and npm installed, run "npm install -g @openai/codex". If Node.js or npm is missing, install Node.js with npm first, then run that command. This installs the current stable Codex CLI.')
    assert.equal(unavailableReason('AGENT_CODEX_CLI_NOT_INSTALLED', { platform }),
      'Codex is not installed on this computer. Open a terminal. With Node.js and npm installed, run "npm install -g @openai/codex". If Node.js or npm is missing, install Node.js with npm first, then run that command. This installs the current stable Codex CLI. Then open a new terminal window and run "codex login"')
  }
})
