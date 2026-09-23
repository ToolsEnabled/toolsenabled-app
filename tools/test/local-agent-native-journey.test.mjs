import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { canonicalRootForTests } from '../canonical-root.mjs'
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs'
import { main, metadata, ownedWorker } from '../agent-really-starts-qa.mjs'
import { planFor, discoverDrivers, localInferenceDriverArguments } from '../packaged-qa-suite.mjs'
import { localQaOptions, selectedModel, readOwnedJson, assertLocalToolTurn, assertLocalStoppedTurn,
  assertLocalCleanup, assertLocalAccountPath, runLocalNativeJourney, LOCAL_QA_ROLE,
  readLocalThread, assertLocalSourceInputs, sha256 } from '../lib/local-agent-native-journey.mjs'
import * as journeyPolicy from '../lib/local-agent-native-journey.mjs'

const SESSION = '11111111-1111-4111-8111-111111111111', THREAD = '22222222-2222-4222-8222-222222222222'
const TURN = '33333333-3333-4333-8333-333333333333', STOP = '44444444-4444-4444-8444-444444444444', LATER = '55555555-5555-4555-8555-555555555555'
const MODEL = 'fixture:1b', FILE = '/fixture/challenge.txt', CONTENT = 'LOCAL_TOOL_CONTENT_fixture_hidden_1234567890\n'
const PROMPT = `Read ${FILE} with host.read_file and return its contents.`
const receipt = () => ({ quiescent: true, started: true, exitedNormally: true, exitCode: 0, hadRemainingChildren: false })
function scratch(t) { const dir = fs.mkdtempSync(path.join(ownedFixtureTempRoot(), 'te-local-driver-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir }

test('the selected Engine admits the actual Local driver fixture and refuses restricted file-reader fixtures', t => {
  const engineRoot = canonicalRootForTests(), require = createRequire(import.meta.url)
  const machine = require(path.join(engineRoot, 'src/lib/setup/machine-record.js'))
  const policy = require(path.join(engineRoot, 'src/lib/permission-tier-policy.js'))
  const registry = require(path.join(engineRoot, 'src/lib/tool-registry.js'))
  const role = { functions: ['host.read_file'], requiresDirectUserAuthorization: true }
  const driver = fs.readFileSync(new URL('../agent-really-starts-qa.mjs', import.meta.url), 'utf8')
  const tier = /seedMachineRecord\(profile, staged\.appRoot, '([^']+)'\)/.exec(driver)?.[1]
  assert.ok(tier, 'measure the actual fixture tier, not a second test-only policy choice')
  assert.equal(tier, 'unrestricted', 'the native fixture must explicitly admit its selected host.read_file proof')
  const root = scratch(t)
  const makeRecord = tier => {
    const servicesRoot = path.join(root, tier), workspace = path.join(servicesRoot, 'workspace')
    fs.mkdirSync(workspace, { recursive: true })
    // Policy-only fixture: no installer/generation or runtime probe is claimed.
    const record = machine.buildMachineRecord({ tier, servicesRoot, installRoot: engineRoot,
      nodePath: process.execPath, workspaceRoots: [workspace] })
    machine.writeJsonAtomic(machine.machineRecordPath(servicesRoot), machine.sealMachineRecord(record, { servicesRoot }))
    return servicesRoot
  }
  const servicesRoot = makeRecord(tier)
  const reading = machine.readMachineRecord({ servicesRoot, adopt: false })
  const tools = registry.TOOL_REGISTRY.filter(row => row.name === 'host.read_file')
  assert.deepEqual(policy.allowedToolNames(tools, policy.installTierSessionFromRecord(reading)), ['host.read_file'],
    'the native journey cannot require a file tool its own recorded tier permanently excludes')
  const check = overrides => journeyPolicy.assertLocalToolPolicy({ engineRoot, servicesRoot, role, agentApiMode: 'Only', ...overrides })
  const result = check()
  assert.equal(result.installTier, 'unrestricted')
  assert.equal(result.agentApiMode, 'Only')
  assert.deepEqual(result.functions, ['host.read_file'])
  for (const restricted of ['guided', 'standard']) {
    assert.throws(() => check({ servicesRoot: makeRecord(restricted) }), { code: 'PERMISSION_CONFINED_EXCLUSION_REFUSED' })
  }
  for (const agentApiMode of ['Enabled', 'Disabled', null]) assert.throws(() => check({ agentApiMode }), /Only/)
  for (const role of [{ functions: null, requiresDirectUserAuthorization: true },
    { functions: ['host.read_file', 'host.exec'], requiresDirectUserAuthorization: true },
    { functions: ['host.read_file'], requiresDirectUserAuthorization: false }]) assert.throws(() => check({ role }))
  const file = machine.machineRecordPath(servicesRoot)
  const before = fs.readFileSync(file, 'utf8'), tampered = JSON.parse(before)
  tampered.tier = 'standard'; fs.writeFileSync(file, JSON.stringify(tampered))
  assert.throws(() => check(), { code: 'SETUP_MACHINE_RECORD_TAMPERED' })
  fs.writeFileSync(file, before)
  assert.deepEqual(check(), result, 'the exact restored fixture must still pass without changing any policy')
})
function toolProof(turnId = TURN, prompt = PROMPT) {
  const output = JSON.stringify({ path: FILE, content: CONTENT, bytes: Buffer.byteLength(CONTENT) })
  const event = (type, more = {}) => ({ sessionId: SESSION, event: { type, threadId: THREAD, turnId, ...more } })
  const packets = [event('turn_accepted'), event('tool_call', { toolCallId: 'read-1', tool: 'host.read_file', payload: { path: FILE } }),
    event('tool_result', { toolCallId: 'read-1', tool: 'host.read_file', status: 'ok', text: output }), event('assistant_text', { text: CONTENT }), event('turn_completed', { status: 'success' })]
  const saved = { version: 1, threadId: THREAD, record: { model: MODEL, turnReceipt: { version: 1, turnId, status: 'success' }, messages: [
    { role: 'user', turnId, content: prompt }, { role: 'tool', turnId, tool_name: 'host.read_file', content: output }, { role: 'assistant', turnId, content: CONTENT }] } }
  return { packets, saved, sessionId: SESSION, turnId, model: MODEL, file: FILE, content: CONTENT, prompt }
}

// These are proof-interpreter and control-orchestration fixtures. They do NOT
// report native/provider/installed acceptance; the real driver must still run.
test('Local inference is absent by default and missing explicit inputs cannot call metadata', async t => {
  let requests = 0
  t.mock.method(globalThis, 'fetch', () => { requests++; throw new Error('must not request') })
  for (const argv of [[], ['--release', '/candidate'], ['--run-local-inference'], ['--run-local-inference', '--release', '/candidate']]) {
    await assert.rejects(main(argv), { code: 'LOCAL_QA_PREREQUISITE', exitCode: 3 })
  }
  assert.equal(requests, 0)
})

test('explicit model selection never downloads, substitutes or targets an external origin', () => {
  const base = ['--run-local-inference', '--release', '/candidate', '--local-model', MODEL]
  assert.equal(localQaOptions(base).endpoint, 'http://127.0.0.1:11434')
  for (const endpoint of ['https://127.0.0.1', 'http://localhost', 'http://192.168.1.4', 'http://user@127.0.0.1', 'http://127.0.0.1/path', 'http://127.0.0.1?x=1']) {
    assert.throws(() => localQaOptions([...base, '--local-endpoint', endpoint]), { code: 'LOCAL_QA_PREREQUISITE' })
  }
  for (const model of ['auto', 'local/auto', '', 'x\n--pull']) assert.throws(() => localQaOptions([...base.slice(0, -1), model]))
  assert.throws(() => localQaOptions([...base, '--local-model', MODEL]))
  const entry = { name: MODEL, digest: 'a'.repeat(64), size: 42 }
  assert.deepEqual(selectedModel({ models: [entry] }, MODEL), entry)
  assert.throws(() => selectedModel({ models: [entry] }, 'missing'), { code: 'LOCAL_QA_PREREQUISITE' })
  assert.throws(() => selectedModel({ models: [entry, entry] }, MODEL), { code: 'LOCAL_QA_PREREQUISITE' })
  assert.throws(() => selectedModel({ models: [{ ...entry, digest: 'unknown' }] }, MODEL))
})

test('Windows profile paths are rejected lexically before any foreign-profile access', () => {
  const options = { platform: 'win32', accountHome: 'C:\\Users\\FixtureOwner' }
  assert.doesNotThrow(() => assertLocalAccountPath('C:\\Users\\FixtureOwner\\Temp\\run', options))
  for (const file of ['C:\\Users\\Other\\run', 'C:\\Users\\FixtureOwner-other\\run', 'C:\\Users\\FixtureOwner\\..\\Other\\run', '\\\\host\\share', 'C:\\Users\\FixtureOwner\\Temp:stream']) assert.throws(() => assertLocalAccountPath(file, options))
})

test('unavailable and malformed local metadata produce prerequisite refusals without raw response bodies', async () => {
  await assert.rejects(metadata('http://127.0.0.1:1', '/api/tags', { fetchImpl: async () => { throw new Error('private fixture detail') } }), error => error.exitCode === 3 && !error.message.includes('private fixture'))
  await assert.rejects(metadata('http://127.0.0.1:1', '/api/tags', { fetchImpl: async () => new Response('private invalid body') }), error => error.exitCode === 3 && !error.message.includes('private invalid'))
  await assert.rejects(metadata('http://127.0.0.1:1', '/api/pull', { fetchImpl: async () => { throw new Error('must not call') } }), /read-only/)
  assert.deepEqual(await metadata('http://127.0.0.1:1', '/api/tags', { fetchImpl: async () => new Response('{"models":[]}') }), { models: [] })
})

test('the proof requires native file-tool output and matching persisted bytes, not an echoed prompt', () => {
  assert.equal(assertLocalToolTurn(toolProof()).turnId, TURN)
  for (const change of [
    f => { f.prompt += CONTENT }, f => { f.packets = f.packets.filter(p => !p.event.type.startsWith('tool_')) },
    f => { f.packets[1].event.payload.path = '/other' }, f => { f.packets[2].event.text = JSON.stringify({ path: FILE, content: CONTENT, bytes: 1 }) },
    f => { f.packets[2].event.status = 'error' }, f => { f.saved.record.messages[1].content += ' ' },
    f => { f.saved.record.turnReceipt.turnId = LATER }, f => { f.saved.record.turnReceipt.status = 'pending' },
    f => { f.saved.record.model = 'substituted:1b' }, f => { f.packets[4].event.status = 'error' },
    f => { f.packets[0].sessionId = LATER }, f => { f.packets[2].event.threadId = LATER },
    f => { f.saved.record.messages[2].content = 'guessed answer' }, f => { f.packets[3].event.text = 'guessed answer' },
  ]) { const f = toolProof(); change(f); assert.throws(() => assertLocalToolTurn(f)) }
})

test('Stop requires actual fresh busy acceptance and an independently persisted interrupted terminal', () => {
  const f = toolProof(STOP), common = { ...f, packets: [f.packets[0], { ...f.packets[4], event: { ...f.packets[4].event, status: 'interrupted' } }], busy: { busy: true, closing: false, at: 10 }, stopAt: 20, terminalAt: 30 }
  common.saved.record.turnReceipt.status = 'interrupted'
  assert.equal(assertLocalStoppedTurn(common).status, 'interrupted')
  for (const change of [f => { f.busy.busy = false }, f => { f.busy.closing = true }, f => { f.stopAt = 3000 }, f => { f.terminalAt = 15 },
    f => { f.packets.shift() }, f => { f.packets[1].event.status = 'success' }, f => { f.saved.record.turnReceipt.status = 'success' }]) {
    const copy = structuredClone(common); change(copy); assert.throws(() => assertLocalStoppedTurn(copy))
  }
})

test('native cleanup refuses absent, unstarted, interrupted and nonempty descendants', () => {
  assert.doesNotThrow(() => assertLocalCleanup(receipt(), { platform: 'linux' }))
  for (const field of ['quiescent', 'started', 'exitedNormally']) assert.throws(() => assertLocalCleanup({ ...receipt(), [field]: false }))
  assert.throws(() => assertLocalCleanup({ ...receipt(), exitCode: 1 }))
  assert.throws(() => assertLocalCleanup({ ...receipt(), hadRemainingChildren: true }))
  assert.throws(() => assertLocalCleanup({ ...receipt(), hadRemainingChildren: undefined }, { platform: 'linux' }))
  const windows = receipt(); delete windows.hadRemainingChildren
  assert.doesNotThrow(() => assertLocalCleanup(windows, { platform: 'win32' }))
})

test('owned saved evidence rejects traversal, links, hardlinks and oversized files', t => {
  const dir = scratch(t), file = path.join(dir, 'receipt.json')
  fs.writeFileSync(file, '{"ok":true}')
  assert.equal(readOwnedJson(dir, 'receipt.json').value.ok, true)
  assert.throws(() => readOwnedJson(dir, '../receipt.json'))
  assert.throws(() => readOwnedJson(dir, 'receipt.json', 2))
  fs.linkSync(file, path.join(dir, 'alias.json'))
  assert.throws(() => readOwnedJson(dir, 'receipt.json'))
  fs.unlinkSync(path.join(dir, 'alias.json'))
  if (process.platform !== 'win32') { fs.symlinkSync(file, path.join(dir, 'link.json')); assert.throws(() => readOwnedJson(dir, 'link.json')) }
})

test('saved Local evidence follows the explicit native state root and never substitutes a default profile', t => {
  const profile = scratch(t), stateRoot = path.join(profile, 'renamed-user-data', 'capability')
  const directory = path.join(stateRoot, 'state', 'local-model-threads')
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, `${THREAD}.json`), JSON.stringify(toolProof().saved))
  assert.equal(readLocalThread(profile, stateRoot, THREAD).value.threadId, THREAD)
  assert.throws(() => readLocalThread(profile, undefined, THREAD))
  assert.throws(() => readLocalThread(profile, path.resolve(profile, '..', 'foreign-profile'), THREAD), /owned profile/)
  assert.throws(() => readLocalThread(profile, stateRoot, '../outside'))
})

test('driver source changes after captured inputs refuse a positive receipt', t => {
  const dir = scratch(t), file = path.join(dir, 'fixture-source.mjs'), content = 'export const value = 1\n'
  fs.writeFileSync(file, content)
  const inputs = [{ path: file, sha256: sha256(content) }]
  assert.doesNotThrow(() => assertLocalSourceInputs(inputs))
  fs.writeFileSync(file, 'export const value = 2\n')
  assert.throws(() => assertLocalSourceInputs(inputs), /source changed/)
})

test('packaged Local journey stays costly opt-in and forwards only its explicit selected inputs', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url))
  const plan = planFor(discoverDrivers(path.join(root, 'tools'))).find(row => row.name === 'agent-really-starts-qa.mjs')
  assert.equal(plan.costly, true)
  assert.equal(plan.excluded, null)
  const args = ['--only', 'agent-really-starts-qa', '--run-local-inference', '--local-model', MODEL, '--local-gpu-policy=Allow CPU fallback']
  assert.deepEqual(localInferenceDriverArguments(plan.key, args), ['--run-local-inference', '--local-model', MODEL, '--local-gpu-policy', 'Allow CPU fallback'])
  assert.deepEqual(localInferenceDriverArguments('other-qa', args), [])
  assert.throws(() => localInferenceDriverArguments(plan.key, [...args, '--local-model=x']))
})

test('a failed ownership measurement cancels its retained owner instead of losing cleanup custody', async t => {
  const dir = scratch(t); let cancelled = 0
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() })
  const owner = { child, completion: Promise.reject(new Error('fixture ownership read failure')), cancel() { cancelled++; return Promise.resolve(receipt()) } }
  await assert.rejects(ownedWorker(path.join(dir, 'input.json'), {}, dir, dir, { spawnClaim: () => owner }), /ownership read failure/)
  assert.equal(cancelled, 1)
})

function controlWorld({ staleLaterAnswer = false, stopAlreadyFinished = false, missingStopTerminal = false } = {}) {
  let clock = 0, phase = 0, draft = '', listener, saved, busy = false, detached = false
  const actions = [], observations = []
  const node = { id: 'local-node', treeId: 'local-tree', tier: 'local', sessionId: SESSION }
  const emit = packet => listener?.(packet)
  const sendProof = turn => {
    const f = toolProof(turn, draft); saved = f.saved
    for (const packet of f.packets) emit(packet)
    busy = false
  }
  const dom = {
    querySelector(selector) {
      if (selector.includes('option[value="local"]')) return {}
      if (selector.includes('data-compose-field="role"')) return { options: [{ value: LOCAL_QA_ROLE, disabled: false }], value: LOCAL_QA_ROLE }
      if (selector.includes('data-compose-field="tier"')) return { options: [{ value: 'local', disabled: false }], value: 'local' }
      throw new Error(`unhandled fixture selector ${selector}`)
    },
    querySelectorAll(selector) {
      assert.ok(selector.includes('.chat-msg-text'))
      const count = phase === 3 && !staleLaterAnswer ? 2 : 1
      return Array.from({ length: count }, () => ({ textContent: CONTENT, getBoundingClientRect: () => ({ height: 20 }) }))
    },
  }
  const native = { mcSettings: {}, mcAgent: {
    onEvent(callback) { listener = callback; return () => { detached = true } },
    sessionActivity: async () => ({ ok: true, busy, closing: false }),
  } }
  const context = vm.createContext({ document: dom, window: native, location: { href: 'http://fixture/#/home' }, localStorage: {
    getItem: () => phase ? JSON.stringify({ nodes: [node] }) : null,
  } })
  const window = {
    evaluate: async expression => {
      const result = await vm.runInContext(expression, context)
      return result === undefined ? undefined : JSON.parse(JSON.stringify(result))
    },
    visibility: async () => ({ state: 'visible', x: 1, y: 1 }),
    waitForVisible: async () => ({ state: 'visible', x: 1, y: 1 }),
    typeInto: async (selector, text) => { draft = text; actions.push(['type', selector, text]); return 'typed' },
    clickVisible: async selector => {
      actions.push(['click', selector])
      if (selector.includes('data-compose-action="start"')) { phase = 1; sendProof(TURN) }
      else if (selector.endsWith('.chat-send')) {
        phase = 2; busy = !stopAlreadyFinished
        emit({ sessionId: SESSION, event: { type: 'turn_accepted', threadId: THREAD, turnId: STOP } })
        if (stopAlreadyFinished) emit({ sessionId: SESSION, event: { type: 'turn_completed', threadId: THREAD, turnId: STOP, status: 'success' } })
      } else if (selector.includes('data-chat-chip="halt"') && !missingStopTerminal) {
        busy = false; saved.record.turnReceipt = { version: 1, turnId: STOP, status: 'interrupted' }
        emit({ sessionId: SESSION, event: { type: 'turn_completed', threadId: THREAD, turnId: STOP, status: 'interrupted' } })
      }
      return 'clicked'
    },
    session: { send: async (method, input) => {
      actions.push([method, input])
      if (method === 'Input.dispatchKeyEvent' && input.type === 'rawKeyDown' && input.key === 'Enter') { phase = 3; sendProof(LATER) }
      return {}
    } },
  }
  const run = () => runLocalNativeJourney({ window, configuration: { model: MODEL, file: FILE, content: CONTENT },
    readThread: async id => { assert.equal(id, THREAD); const json = JSON.stringify(saved); return { value: structuredClone(saved), json, sha256: sha256(json) } },
    record: async (name, data) => observations.push({ name, data }), now: () => clock, pause: async ms => { clock += ms },
  })
  return { run, actions, observations, detached: () => detached }
}

test('the maintained journey sequences control input, actual acceptance/busy Stop, terminal and later Enter evidence', async () => {
  const f = controlWorld(), result = await f.run()
  assert.equal(result.first.turnId, TURN); assert.equal(result.stopped.turnId, STOP); assert.equal(result.later.turnId, LATER)
  assert.equal(f.detached(), true)
  assert.deepEqual(f.observations.map(row => row.name), ['first-tool-turn', 'stopped-turn', 'later-tool-turn'])
  for (const { data } of f.observations) {
    assert.equal(sha256(data.savedJson), data.savedSha256)
    const saved = JSON.parse(data.savedJson)
    assert.equal(saved.record.turnReceipt.turnId, data.turnId)
    assert.equal(saved.record.turnReceipt.status, data.status || 'success')
    assert.ok(data.nativePackets.every(packet => packet.sessionId === data.sessionId && packet.event.turnId === data.turnId))
    assert.equal(data.nativePackets.filter(packet => packet.event.type === 'turn_completed').length, 1)
  }
  const stop = f.actions.findIndex(row => row[0] === 'click' && row[1].includes('data-chat-chip="halt"'))
  const enter = f.actions.findIndex(row => row[0] === 'Input.dispatchKeyEvent' && row[1].key === 'Enter')
  assert.ok(stop >= 0 && enter > stop)
})

test('the maintained journey refuses stale later UI output even when the native later receipt succeeded', async () => {
  const f = controlWorld({ staleLaterAnswer: true })
  await assert.rejects(f.run(), /rendered later assistant answer/)
  assert.equal(f.observations.some(row => row.name === 'later-tool-turn'), false)
})

for (const mode of ['stopAlreadyFinished', 'missingStopTerminal']) test(`the maintained journey cannot manufacture Stop evidence: ${mode}`, async () => {
  const f = controlWorld({ [mode]: true })
  await assert.rejects(f.run(), mode === 'stopAlreadyFinished' ? /completed before it could be exercised/ : /actual native terminal event/)
  assert.equal(f.actions.some(row => row[0] === 'Input.dispatchKeyEvent' && row[1].key === 'Enter'), false, 'later send must wait for the proved interruption')
})


test('cancelled or output-limited ownership cannot pass merely because the owner then reports empty descendants', async t => {
  const dir = scratch(t); let resolveCompletion, cancelled = 0
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() })
  const completion = new Promise(resolve => { resolveCompletion = resolve })
  const owner = { child, completion, cancel() { cancelled++; resolveCompletion(receipt()); return completion } }
  const running = ownedWorker(path.join(dir, 'input.json'), {}, dir, dir, { spawnClaim: () => owner })
  child.stdout.emit('data', Buffer.alloc(1024 * 1024 + 1))
  await assert.rejects(running, /cancelled, timed out, or exceeded/)
  assert.equal(cancelled, 1)
})

test('a failed retained output pipe cancels native ownership and cannot emit success', async t => {
  const dir = scratch(t); let resolveCompletion, cancelled = 0
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() })
  const completion = new Promise(resolve => { resolveCompletion = resolve })
  const owner = { child, completion, cancel() { cancelled++; resolveCompletion(receipt()); return completion } }
  const running = ownedWorker(path.join(dir, 'input.json'), {}, dir, dir, { spawnClaim: () => owner })
  child.stderr.emit('error', new Error('fixture pipe failure'))
  await assert.rejects(running, /cancelled, timed out, or exceeded/)
  assert.equal(cancelled, 1)
})
