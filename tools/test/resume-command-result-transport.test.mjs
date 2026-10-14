import { canonicalRootForTests } from '../canonical-root.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'

const hash = value => createHash('sha256').update(value).digest('hex')
// The retained baseline/fixed copies have an explicit adjacent proof binding.
// The release test has no fixture binding: it reads only its candidate tree
// and the engine selected by the existing canonical test preloader.
let config
try { config = JSON.parse(readFileSync(new URL('./resume-result-transport-fixture.json', import.meta.url))) }
catch (error) {
  if (error.code !== 'ENOENT') throw error
  const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const engine = canonicalRootForTests({ requireConfigured: true })
  const files = Object.fromEntries(['src/views/computers.js', 'src/main.js', 'shell/main.cjs',
    'src/resume-assignment.js', 'shell/tree-node-command-broker.cjs'].map(rel => [rel, path.join(app, rel)]))
  Object.assign(files, { preload: path.join(app, 'shell/fleet-profile-preload.cjs'),
    engineCommand: path.join(engine, 'src/lib/agent-tree-spawn.js'),
    engineRegistry: path.join(engine, 'src/lib/tree-host-registry.js') })
  config = { mode: 'candidate', inputs: Object.fromEntries(Object.entries(files).map(([key, value]) =>
    [key, { path: value, sha256: hash(readFileSync(value)) }])) }
}
const sources = {}
for (const [key, input] of Object.entries(config.inputs)) {
  const bytes = readFileSync(input.path)
  assert.equal(hash(bytes), input.sha256, `${key}: frozen current input`)
  sources[key] = bytes.toString()
}
const patch = config.mode === 'candidate' ? '' : readFileSync(new URL(config.patch, import.meta.url), 'utf8')
if (config.mode !== 'candidate') assert.equal(hash(patch), config.patchSha256)

// Apply the delivered unified patch in memory. Never write the source checkout.
function applySection(source, section) {
  const original = source.match(/.*\n|.+$/g) || []
  const lines = section.match(/.*\n|.+$/g) || []
  let cursor = 0, i = 2
  const result = []
  while (i < lines.length) {
    const match = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(lines[i++])
    assert.ok(match, 'valid unified hunk')
    const at = Number(match[1]) - 1
    result.push(...original.slice(cursor, at)); cursor = at
    while (i < lines.length && !lines[i].startsWith('@@ ')) {
      const line = lines[i++]
      if (' -'.includes(line[0])) assert.equal(original[cursor++], line.slice(1), 'exact hunk preimage')
      if (' +'.includes(line[0])) result.push(line.slice(1))
    }
  }
  return [...result, ...original.slice(cursor)].join('')
}
for (const section of patch.split(/(?=^--- a\/)/m).filter(Boolean)) {
  const key = section.split('\n')[0].slice(6)
  const fixed = applySection(sources[key], section)
  assert.equal(hash(fixed), config.postimages[key], `${key}: exact postimage`)
  const omitted = config.mode === 'baseline'
    || (config.mode === 'no-renderer-forward' && key === 'src/main.js')
    || (config.mode === 'no-shell-forward' && key === 'shell/main.cjs')
  if (!omitted) sources[key] = fixed
}
function span(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length)
  assert.ok(a >= 0 && b > a, `real source span: ${start}`)
  return source.slice(a, b)
}
const require = createRequire(import.meta.url)
const { createTreeNodeCommandBroker, treeNodeCommandRefusalSentence } = require(config.inputs['shell/tree-node-command-broker.cjs'].path)
const tree = require(config.inputs.engineCommand.path)
const { sendResumeAssignment } = await import(pathToFileURL(config.inputs['src/resume-assignment.js'].path))
const deliverSource = span(sources['src/views/computers.js'], '  async function deliverResumeAssignment(', '  async function resumeNodeSession(')
const completeSource = span(sources['src/main.js'], 'async function completeTreeNodeCommand(', '/* A REQUEST THIS RENDERER')
const resolveSource = span(sources['shell/main.cjs'], 'function resolveLocalTreeCommand(', 'const { CONFIGURATION_ACTIONS')
const preloadSource = span(sources.preload, "contextBridge.exposeInMainWorld('mcTreeCommand'", '/* NOTIFICATIONS:')
const ipcSource = span(sources['shell/main.cjs'], "ipcMain.handle('mc-tree-command:complete'", 'function safeExportName(')
const publishSource = span(sources['shell/main.cjs'], '  publishResult: (envelope, result) => envelope?.local === true', '  sendToRenderer:')

// Real current deliver/helper -> renderer complete -> preload invoke -> main IPC
// -> real broker -> real local resolver -> engine commandOnTree returned value.
// Provider/start and Electron are inert boundary fixtures; no live lifecycle call.
async function roundTrip(t, options = {}) {
  const node = { id: 'node-current', sessionId: 'session-restored' }
  const sends = [], lines = [], states = [], ipcCalls = [], completions = []
  const waiting = new Map(), handlers = new Map(), views = {}
  const errors = []
  const store = { getNode: () => node, setNodeStatus: (...args) => states.push(args) }
  const answer = { ok: true, code: null, nodeId: node.id, sessionId: node.sessionId, threadId: 'thread-retained' }
  const dependencies = {
    sendResumeAssignment,
    window: { mcAgent: { send: async request => { sends.push(request); return options.send ? options.send(request) : { ok: true } } } },
    sessionNodeIds: new Map(options.bound === false ? [] : [[node.sessionId, node.id]]),
    transcriptAppend: (id, line) => lines.push({ id, ...line }),
    refreshTree: () => {}, statusNote: value => value,
    RESUME_PANEL: { assignmentNotSent: 'The next assignment was not sent.' },
    refusalCode: error => error.code, refusalCodeOf: result => result.code,
    nodeBusy: () => false, nodeSessionEnded: () => false,
    outboxTakeNext: () => null,
    drainOutboxMessage: () => assert.fail('no queued input in this fixture'),
  }
  const deliver = Function(...Object.keys(dependencies), deliverSource + '\nreturn deliverResumeAssignment')(...Object.values(dependencies))
  const treeSpawnError = (code, message) => Object.assign(new Error(message), { code })
  const resolve = Function('localTreeCommands', 'treeSpawnError', 'treeNodeCommandRefusalSentence', 'treeCommandRefusalSentence',
    resolveSource + '\nreturn resolveLocalTreeCommand')(waiting, treeSpawnError, treeNodeCommandRefusalSentence, (_action, code, reason) => reason || code)
  const publish = Function('resolveLocalTreeCommand', 'publishTreeNodeCommandResult',
    'return ({' + publishSource + '}).publishResult')(resolve, () => assert.fail('local resume must not use file spool'))
  let requestEnvelope, broker, dispatchDone
  const dispatchFinished = new Promise(resolve => { dispatchDone = resolve })
  broker = createTreeNodeCommandBroker({
    loadAndClaim: id => { assert.equal(id, requestEnvelope.request.requestId); return requestEnvelope },
    publishResult: publish,
    sendToRenderer: async command => {
      try {
        const assignment = { text: command.assignment, fromName: 'Manager', submitted: options.alreadySubmitted === true }
        const result = options.viewResult || await deliver({ command, assignment,
          resumeOutcome: options.resumeOutcome ?? 'engine', answer, node, store })
        if (options.mismatchFirst) {
          assert.equal((await views.mcTreeCommand.complete({ ...result, requestId: 'wrong-request' })).code, 'MC_TREE_COMMAND_RESULT_MISMATCH')
          assert.equal(waiting.size, 1, 'mismatch cannot consume the actual caller')
        }
        await complete(command, result)
      } finally { dispatchDone() }
    },
    onError: error => errors.push(error),
  })
  const gateEvent = { sender: { id: 'fixture-fleet-renderer' } }
  Function('ipcMain', 'withFleetProfileSender', 'treeNodeCommandBroker', ipcSource)(
    { handle: (name, handler) => handlers.set(name, handler) },
    (event, body) => { assert.equal(event, gateEvent); return body() }, broker)
  Function('contextBridge', 'ipcRenderer', preloadSource)(
    { exposeInMainWorld: (name, value) => { views[name] = value } },
    { invoke: async (name, value) => { ipcCalls.push(name); completions.push(value); return handlers.get(name)(gateEvent, value) } })
  const complete = Function('window', 'treeNodeCommandReason', completeSource + '\nreturn completeTreeNodeCommand')(
    views, value => typeof value === 'string' ? value.slice(0, 1200) : null)
  tree.installTreeSpawnHost({
    spawn: () => assert.fail('no spawn'), isTreeSession: () => true, resumeAssignmentVersion: 1,
    command: request => new Promise((resolve, reject) => {
      requestEnvelope = { local: true, request: { ...request, requestId: 'request-current',
        expiresAt: new Date(Date.now() + 300000).toISOString() } }
      waiting.set('request-current', { resolve, reject })
      broker.setRendererReady(true)
      assert.equal(broker.queueRequest('request-current'), true)
    }),
  })
  t.after(() => { broker.dispose(); tree.clearTreeSpawnHost() })
  const promise = tree.commandOnTree(options.verb || 'resume', {
    parentSessionId: 'session-parent', nodeId: node.id, expectedSessionId: 'session-predecessor',
    ...(options.noAssignment ? {} : { assignment: 'Review the current remaining source.' }),
  })
  let result, error
  try { result = await promise } catch (caught) { error = caught }
  await dispatchFinished
  assert.equal(errors.length, 0)
  assert.equal(waiting.size, 0)
  assert.ok(ipcCalls.every(x => x === 'mc-tree-command:complete'))
  return { result, error, sends, lines, states, completions }
}

for (const code of ['MC_TRANSCRIPT_ADMISSION_PENDING', 'RULES_CONTEXT_CHANGED', 'ACTION_PERMISSION_DENIED']) {
  test(`supported resume response preserves returned ${code} after restoring session`, async t => {
    const h = await roundTrip(t, { send: () => ({ ok: false, code }) })
    assert.equal(h.error, undefined)
    assert.equal(h.result.ok, true)
    assert.equal(h.result.firstTurnState, 'not-submitted')
    assert.equal(h.result.code, code)
    assert.equal(h.result.sessionId, 'session-restored')
    assert.equal(h.result.threadId, 'thread-retained')
    assert.equal(h.sends.length, 1)
  })
}
test('supported resume response preserves thrown first-input refusal without retry', async t => {
  const h = await roundTrip(t, { send: () => { throw Object.assign(new Error('active'), { code: 'AGENT_TURN_ACTIVE' }) } })
  assert.equal(h.result.code, 'AGENT_TURN_ACTIVE')
  assert.equal(h.result.firstTurnState, 'not-submitted')
  assert.equal(h.sends.length, 1)
})
test('changed binding refuses assignment without provider send or transcript write', async t => {
  const h = await roundTrip(t, { bound: false })
  assert.equal(h.result.code, 'MC_TREE_COMMAND_SESSION_CHANGED')
  assert.equal(h.sends.length, 0)
  assert.equal(h.lines.length, 0)
  assert.equal(h.states.length, 0)
})
test('successful first input survives the supported response exactly once with no refusal code', async t => {
  const h = await roundTrip(t)
  assert.equal(h.result.firstTurnState, 'submitted')
  assert.equal(h.result.code, undefined)
  assert.equal(h.sends.length, 1)
})
test('assignment carried in continuation is not sent again by the return path', async t => {
  const h = await roundTrip(t, { alreadySubmitted: true, resumeOutcome: true })
  assert.equal(h.result.firstTurnState, 'submitted')
  assert.equal(h.result.code, undefined)
  assert.equal(h.sends.length, 0)
})
test('unattempted first input has bounded fallback reason at the actual caller', async t => {
  const h = await roundTrip(t, { resumeOutcome: true })
  assert.equal(h.result.code, 'MC_TREE_COMMAND_ASSIGNMENT_NOT_SUBMITTED')
  assert.equal(h.sends.length, 0)
})
test('invalid first-input code cannot put arbitrary text in supported result', async t => {
  const h = await roundTrip(t, { send: () => ({ ok: false, code: 'private text\nnot a code' }) })
  assert.equal(h.result.code, 'MC_TREE_COMMAND_ASSIGNMENT_NOT_SUBMITTED')
  assert.equal(h.completions[0].code, 'MC_TREE_COMMAND_ASSIGNMENT_NOT_SUBMITTED')
})
test('mismatched completion refuses without consuming the real successful response', async t => {
  const h = await roundTrip(t, { mismatchFirst: true })
  assert.equal(h.result.firstTurnState, 'submitted')
  assert.equal(h.sends.length, 1)
})
test('resume without assignment does not gain first-input fields from unexpected renderer metadata', async t => {
  const h = await roundTrip(t, { noAssignment: true, viewResult: { ok: true, nodeId: 'node-current',
    sessionId: 'session-restored', threadId: 'thread-retained', firstTurnState: 'not-submitted', code: 'AGENT_TURN_ACTIVE' } })
  assert.equal(h.result.firstTurnState, undefined)
  assert.equal(h.result.code, undefined)
  assert.equal(h.completions[0].code, null)
})
test('lifecycle permission refusal remains a refusal and never sends an assignment', async t => {
  const h = await roundTrip(t, { viewResult: { ok: false, code: 'ACTION_PERMISSION_DENIED', reason: 'Resume is not permitted.' } })
  assert.equal(h.result, undefined)
  assert.equal(h.error.code, 'ACTION_PERMISSION_DENIED')
  assert.equal(h.sends.length, 0)
})
