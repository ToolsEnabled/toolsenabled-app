import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { parseAst } from 'rollup/parseAst'

const require_ = createRequire(import.meta.url)
const ROOT = resolve(import.meta.dirname, '..', '..')
const read = file => readFileSync(resolve(ROOT, file), 'utf8')
const { narrowTurnOptions } = require_(resolve(ROOT, 'shell', 'agent-host.cjs'))
const { createAgentCommandSurface, REQUIRED_DEPS } = require_(resolve(ROOT, 'shell', 'agent-command-surface.cjs'))

// Execute the actual strict parsers without starting main.cjs or Electron.
const MAIN = read('shell/main.cjs')
const mainAst = parseAst(MAIN)
const parserNames = ['agentIpcError', 'agentPayload', 'boundedAgentString', 'parseAgentSend', 'parseAgentSessionCommand']
const parserCode = parserNames.map(name => {
  const nodes = mainAst.body.filter(node => node.type === 'FunctionDeclaration' && node.id.name === name)
  assert.equal(nodes.length, 1, `The actual ${name} parser must be unambiguous`)
  return MAIN.slice(nodes[0].start, nodes[0].end)
})
const limitNames = ['MAX_SESSION_ID_LENGTH', 'MAX_TURN_TEXT_LENGTH']
const limitCode = limitNames.map(name => {
  const nodes = mainAst.body.filter(node => node.type === 'VariableDeclaration')
    .flatMap(node => node.declarations).filter(node => node.id.name === name)
  assert.equal(nodes.length, 1, `The actual ${name} limit must be unambiguous`)
  return `const ${MAIN.slice(nodes[0].start, nodes[0].end)};`
})
const parsers = new Function([...limitCode, ...parserCode,
  'return { parseAgentSend, parseAgentSessionCommand, MAX_SESSION_ID_LENGTH };'].join('\n'))()

function commandSurfaceForTurnTest() {
  const calls = []
  const owner = {}
  const sessions = new Map([
    ['session-1', { owner, state: 'ready', attachments: new Set() }],
    ['session-2', { owner, state: 'ready', attachments: new Set() }],
  ])
  const fail = (code, message) => { const error = new Error(message); error.code = code; throw error }
  const deps = {}
  for (const [name, kind] of Object.entries(REQUIRED_DEPS)) {
    deps[name] = kind === 'function' ? (() => null)
      : kind === 'number' ? 8
        : kind === 'string' ? ROOT
          : {}
  }
  const host = { sendTurn: async request => { calls.push(request); return { ok: true } } }
  Object.assign(deps, {
    agentSessions: sessions,
    currentAgentHost: () => host,
    agentIpcError: fail,
    parseAgentSend: parsers.parseAgentSend,
    parseAgentSessionCommand: parsers.parseAgentSessionCommand,
    rendererSafeAgentError: error => error,
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['picked.png'] }) },
    AGENT_EFFORT_VALUES: [],
    ensureWorkspaceRoot: () => ROOT,
  })
  return { surface: createAgentCommandSurface(deps), calls, owner, sessions }
}

/* C3: the wire widens without the plan losing an inch. The renderer may pick
   a MODEL per turn; everything else it might ask for refuses by name, and the
   plan's approvalPolicy rides over whatever survives. */

const TIERS = Object.freeze({
  luna: { provider: 'codex', model: 'gpt-5.6-luna' },
  terra: { provider: 'codex', model: 'gpt-5.6-terra' },
  'claude-opus': { provider: 'claude', model: 'claude/opus' },
})
const PLAN = Object.freeze({ sandbox: 'read-only', approvalPolicy: 'never' })

test('a codex model rides; the plan re-asserts its policy over it', () => {
  const narrowed = narrowTurnOptions(PLAN, { model: 'gpt-5.6-terra' }, TIERS)
  assert.deepEqual(narrowed, { model: 'gpt-5.6-terra', approvalPolicy: 'never' })
  assert.equal(narrowTurnOptions(PLAN, undefined, TIERS), null, 'no request narrows nothing')
  assert.equal(narrowTurnOptions(PLAN, {}, TIERS), null, 'an empty request narrows nothing')
})

test('the plan-owned axes refuse BY NAME, whatever the value', () => {
  for (const forbidden of [
    { sandbox: 'danger-full-access' },
    { approvalPolicy: 'on-request' },
    { approvalPolicy: 'never' },
    { cwd: 'C:/anywhere' },
    { serviceTier: 'priority' },
    { lastTurnId: 'turn-1' },
  ]) {
    assert.throws(() => narrowTurnOptions(PLAN, forbidden, TIERS),
      error => error.code === 'AGENT_TURN_OPTION_FORBIDDEN',
      `${Object.keys(forbidden)[0]} must refuse by name — even re-stating the plan's own value is not the renderer's sentence to say`)
  }
})

test('a model without a launcher refuses like the start channel does', () => {
  assert.throws(() => narrowTurnOptions(PLAN, { model: 'claude/opus' }, TIERS),
    error => error.code === 'AGENT_TIER_NO_LAUNCHER')
  assert.throws(() => narrowTurnOptions(PLAN, { model: 'gpt-9-imaginary' }, TIERS),
    error => error.code === 'AGENT_TIER_UNKNOWN')
})

test('the send channel takes model and images, and images only from the picker', async () => {
  const shell = read('shell/main.cjs')
  const parse = parsers.parseAgentSend
  const reviewed = { sessionId: 'session-1', text: 'look', model: 'model-1', images: [{ path: 'picked.png' }], holdKey: 'held-1' }
  assert.deepEqual(parse(reviewed), reviewed, 'the actual parser must retain every reviewed send field')
  for (const field of ['sandbox', 'approvalPolicy', 'cwd', 'serviceTier', 'lastTurnId', 'unexpected']) {
    assert.throws(() => parse({ sessionId: 'session-1', text: 'look', [field]: 'forbidden' }),
      error => error.code === 'MC_AGENT_INVALID_PAYLOAD', `${field} must be rejected at the IPC boundary`)
  }
  for (const invalid of [{ holdKey: '' }, { holdKey: 'x'.repeat(129) }, { holdKey: 1 },
    { images: Array.from({ length: 9 }, () => ({ path: 'picked.png' })) }, { images: [{ path: '' }] }]) {
    assert.throws(() => parse({ sessionId: 'session-1', text: 'look', ...invalid }),
      error => error.code === 'MC_AGENT_INVALID_PAYLOAD', 'reviewed fields must remain bounded')
  }
  assert.match(shell.slice(shell.indexOf(`ipcMain.handle('mc-agent:send'`), shell.indexOf(`ipcMain.handle('mc-agent:send'`) + 300), /run\('agent:send'/,
    'the send channel no longer dispatches to the shared surface')
  const harness = commandSurfaceForTurnTest()
  const principal = { kind: 'window', owner: harness.owner, mayWrite: true, label: 'window' }
  /* Mutation proof: replacing the issued-path check with an unconditional pass
     fails this file with "Missing expected rejection: an unpicked image path
     reached model context instead of refusing by name". */
  await assert.rejects(
    harness.surface.run('agent:send', { sessionId: 'session-1', text: 'look', images: [{ path: 'unpicked.png' }] }, principal),
    error => error.code === 'MC_AGENT_ATTACHMENT_UNKNOWN',
    'an unpicked image path reached model context instead of refusing by name',
  )
  assert.equal(harness.calls.length, 0, 'an unpicked image reached the host')
  for (const channel of ['mc-agent:pick-attachment', 'mc-agent:pick-mention']) {
    const handler = shell.slice(shell.indexOf(`ipcMain.handle('${channel}'`))
    assert.ok(handler.length > 100, `${channel} left the shell`)
    assert.match(handler.slice(0, 400), /assertTrustedAgentSender/, `${channel} skips the sender check`)
    assert.match(handler.slice(0, 400), new RegExp(`run\\('${channel.replace('mc-', '')}'`), `${channel} does not dispatch to the shared surface`)
  }
  await harness.surface.run('agent:pick-attachment', { sessionId: 'session-1' }, principal)
  /* Mutation proof: deleting the attachment picker's attachments.add(chosen)
     fails this file with "Got unwanted rejection: the attachment picker did
     not authorize its picked image for this session". */
  await assert.doesNotReject(
    harness.surface.run('agent:send', { sessionId: 'session-1', text: 'look', model: 'model-1', images: [{ path: 'picked.png' }] }, principal),
    'the attachment picker did not authorize its picked image for this session',
  )
  /* Mutation proof: omitting either images or options from the host request
     fails this file with "the picked image and requested model did not reach
     the host together". */
  assert.deepEqual(harness.calls, [{ sessionId: 'session-1', text: 'look', images: [{ path: 'picked.png' }], options: { model: 'model-1' }, origin: 'person' }],
    'the picked image and requested model did not reach the host together')
  await assert.rejects(
    harness.surface.run('agent:send', { sessionId: 'session-2', text: 'look', images: [{ path: 'picked.png' }] }, principal),
    error => error.code === 'MC_AGENT_ATTACHMENT_UNKNOWN',
    'an attachment right leaked from one session to another',
  )
  /* Mutation proof: issuing the picked path to every session instead of only
     its owning session fails this file with "Missing expected rejection: an
     attachment right leaked from one session to another". */
  await harness.surface.run('agent:pick-mention', { sessionId: 'session-2' }, principal)
  /* Mutation proof: saving picked.filePaths[0] into session.attachments in the
     mention picker fails this file with "Missing expected rejection: the
     mention picker issued image rights — a mention is words, not an attachment". */
  await assert.rejects(
    harness.surface.run('agent:send', { sessionId: 'session-2', text: 'look', images: [{ path: 'picked.png' }] }, principal),
    error => error.code === 'MC_AGENT_ATTACHMENT_UNKNOWN',
    'the mention picker issued image rights — a mention is words, not an attachment',
  )
  const preload = read('shell/fleet-profile-preload.cjs')
  assert.match(preload, /pickAttachment/, 'the renderer lost the attachment picker')
  assert.match(preload, /pickMention/, 'the renderer lost the mention picker')
})

test('the actual send parser accepts the bounded optional hold key and refuses malformed keys', () => {
  const base = { sessionId: 'session-1', text: 'look', model: 'model-1', images: [{ path: 'picked.png' }] }
  assert.deepEqual(parsers.parseAgentSend(base), base)
  const holdKey = 'h'.repeat(parsers.MAX_SESSION_ID_LENGTH)
  assert.deepEqual(parsers.parseAgentSend({ ...base, holdKey }), { ...base, holdKey })
  for (const invalid of ['', null, 7, 'held\0paste', holdKey + 'x']) {
    assert.throws(() => parsers.parseAgentSend({ ...base, holdKey: invalid }),
      error => error.code === 'MC_AGENT_INVALID_PAYLOAD',
      'A malformed hold key must be refused by the real boundary')
  }
})

test('the strict send surface refuses unknown fields before invoking its host', async () => {
  const harness = commandSurfaceForTurnTest()
  const principal = { kind: 'window', owner: harness.owner, mayWrite: true, label: 'window' }
  for (const key of ['cwd', 'sandbox', 'approvalPolicy', 'serviceTier', 'turnId', 'unexpectedField']) {
    await assert.rejects(harness.surface.run('agent:send', { sessionId: 'session-1', text: 'look', [key]: 'unexpected' }, principal),
      error => error.code === 'MC_AGENT_INVALID_PAYLOAD', key)
  }
  assert.equal(harness.calls.length, 0, 'A refused request must not reach the host')
})

test('the host passes images and narrowed options to the adapter, and the plan is per-session state', () => {
  const host = read('shell/agent-host.cjs')
  /* TWO WRITE SITES SINCE 2026-08-18, AND BOTH ARE PINNED.

     This read `planThreadOptions: plan.threadOptions`, one literal, back when
     there was one plan. There are now two: the session is CONSTRUCTED holding the
     plan built synchronously, and if account switching picks one of the several
     sign-ins a person has, the session is RE-planned onto that account and the
     field is re-pointed at the plan that actually bound the thread.

     Matching only the first would let the second drift; matching only the second
     would allow a session to exist holding no plan at all between construction and
     the re-plan, which is the window a turn must never be sent in. Requiring both
     is a STRICTER pin than the one it replaces, not an accommodation of the change
     that broke it. */
  assert.match(host, /planThreadOptions: basePlan\.threadOptions/,
    'the session is no longer constructed holding the plan it was started under')
  assert.match(host, /session\.planThreadOptions = plan\.threadOptions/,
    'a session re-planned onto a chosen account no longer keeps the plan that actually bound it')
  // The image-support checks precede narrowing. Bind the real function and
  // declaration by syntax so longer comments cannot hide the narrowing call.
  const sendFunctions = []
  function visit(node) {
    if (!node || typeof node !== 'object') return
    if (node.type === 'FunctionDeclaration' && node.id?.name === 'sendTurn') sendFunctions.push(node)
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object') visit(value)
    }
  }
  visit(parseAst(host))
  assert.equal(sendFunctions.length, 1, 'the actual sendTurn declaration must be unambiguous')
  const sendFunction = sendFunctions[0]
  const turnDeclarations = sendFunction.body.body.filter(node => node.type === 'VariableDeclaration')
    .flatMap(node => node.declarations).filter(node => node.id.name === 'turnOptions')
  assert.equal(turnDeclarations.length, 1, 'sendTurn must bind its narrowed turn options once')
  const turnDeclaration = turnDeclarations[0]
  const send = host.slice(sendFunction.start, sendFunction.end)
  assert.match(host.slice(turnDeclaration.start, turnDeclaration.end), /narrowTurn\(session\.planThreadOptions, options\)/,
    'per-turn options are no longer narrowed against the SAME plan that bound the thread')
  // Evaluate the actual adapter call, independently of its Promise wrapper
  // and indentation. Both reviewed arguments must survive together; absent
  // options must remain absent.
  // The host now constructs the bounded request once, then passes that same
  // object through either the structured-local or ordinary adapter seam. Keep
  // this test pinned to the real request shape without requiring an inline
  // object literal at the call site.
  const requestStart = send.indexOf('const request = {')
  const requestEnd = send.indexOf('\n      }', requestStart)
  const ordinaryCall = send.indexOf('session.adapter.sendTurn(request)', requestEnd)
  assert.ok(requestStart >= 0 && requestEnd > requestStart && ordinaryCall >= 0, 'missing actual adapter request/call')
  const expression = send.slice(requestStart, requestEnd + '\n      }'.length) + `\n${send.slice(ordinaryCall, ordinaryCall + 'session.adapter.sendTurn(request)'.length)}`
  for (const turnOptions of [{ model: 'gpt-5.6-terra', approvalPolicy: 'never' }, null]) {
    const requests = []
    const images = [{ path: 'picked.png' }]
    const returned = runInNewContext(expression, {
      session: { threadId: 'thread-1', adapter: { sendTurn: request => { requests.push(structuredClone(request)); return 'accepted' } } },
      outgoingText: 'look', localText: 'look', turnImages: images, turnOptions,
    }, { filename: 'host-send-call-fixture.cjs' })
    assert.equal(returned, 'accepted')
    assert.deepEqual(requests, [{ threadId: 'thread-1', text: 'look', images, ...(turnOptions ? { options: turnOptions } : {}) }])
  }
})

test('effort is a start-time property: boundary-validated, tier-defaulted, bound at spawn', () => {
  // Iteration 5 W10, CORRECTED in iteration 7. The spawn flag is real and
  // proven to land (config/read and thread/start both report it back), so
  // every layer of that chain stays pinned -- a control that looks real and
  // is not is the defect the tier comment in main.cjs records. What was
  // WRONG was the claim that the protocol has no effort field: it has two
  // (turn/start's `effort`, and thread/settings/update), and the app now
  // uses the latter so a running agent can change depth without a restart.
  // The values are the provider's own, and the closed set is load-bearing
  // because codex accepts an unknown effort silently -- measured: it took
  // `banana` and echoed it back untouched.
  const mainSource = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
  assert.match(mainSource, /'sessionId', 'cwd', 'surface', 'tier', 'effort'/, 'the start IPC no longer accepts effort')
  assert.match(mainSource, /const AGENT_EFFORT_VALUES = Object\.freeze\(\['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'\]\)/,
    "the boundary's effort set drifted from the provider's own vocabulary")
  assert.match(mainSource, /MC_AGENT_EFFORT_UNKNOWN/, 'the boundary no longer refuses unknown efforts by name')
  const hostSource = readFileSync(new URL('../../shell/agent-host.cjs', import.meta.url), 'utf8')
  assert.match(hostSource, /const EFFORT_KEYS = new Set\(\['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'\]\)/,
    "the host's effort set drifted from the provider's own vocabulary")
  assert.match(hostSource, /async function setSessionEffort/,
    'the host lost the in-place depth change, so the product is back to restarting an agent to think harder')
  assert.match(hostSource, /resolveEffort\(effort, startTier\)/, 'startSession no longer resolves effort against the tier default')
  assert.match(hostSource, /model_reasoning_effort=\$\{sessionEffort\}/, 'the spawn seam no longer binds effort; the dead tier field is dead again')
  assert.match(hostSource, /effort: sessionEffort/, 'the session record no longer keeps the spawned effort')
  assert.match(hostSource, /useClaude && sessionEffort \? \{ effort: sessionEffort \}/,
    'Claude starts no longer carry the selected effort to their provider-specific argv builder')
})
