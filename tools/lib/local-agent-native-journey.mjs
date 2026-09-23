import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'

export const LOCAL_QA_ROLE = 'local-qa-reader'
export const LOCAL_QA_LIMIT_MS = 240_000
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$/
export const sha256 = value => crypto.createHash('sha256').update(value).digest('hex')
export function prerequisite(message) { throw Object.assign(new Error(message), { code: 'LOCAL_QA_PREREQUISITE', exitCode: 3 }) }

export function localQaOptions(argv) {
  const flags = new Set(['--run-local-inference', '--visible'])
  const valued = new Set(['--release', '--local-model', '--local-endpoint', '--local-gpu-policy', '--out'])
  const values = new Map()
  for (let i = 0; i < argv.length; i++) {
    const [name, ...rest] = argv[i].split('=')
    if (!flags.has(name) && !valued.has(name)) prerequisite(`Unknown Local QA option: ${name}`)
    if (values.has(name)) prerequisite(`Local QA option repeated: ${name}`)
    if (flags.has(name)) { if (rest.length) prerequisite(`${name} takes no value`); values.set(name, true); continue }
    const value = rest.length ? rest.join('=') : argv[++i]
    if (typeof value !== 'string' || !value || value.startsWith('--')) prerequisite(`${name} needs an explicit value`)
    values.set(name, value)
  }
  if (!values.has('--run-local-inference')) prerequisite('Pass --run-local-inference to authorize the bounded real Local model journey.')
  if (!values.has('--release')) prerequisite('Pass --release with the exact candidate directory; source overlays are not supported.')
  const model = values.get('--local-model')
  if (!MODEL.test(model || '') || model === 'auto' || model.startsWith('local/')) prerequisite('Pass --local-model with one exact installed Ollama model identifier; automatic model selection is forbidden.')
  let endpoint
  try { endpoint = new URL(values.get('--local-endpoint') || 'http://127.0.0.1:11434') } catch { prerequisite('Local QA endpoint must be a loopback HTTP origin.') }
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') {
    prerequisite('Local QA endpoint must be a literal loopback HTTP origin without credentials, a path, query or fragment.')
  }
  const gpuPolicy = values.get('--local-gpu-policy') || 'Require GPU'
  if (!['Require GPU', 'Allow CPU fallback', 'CPU only'].includes(gpuPolicy)) prerequisite('Local QA GPU policy must be an existing product choice.')
  return Object.freeze({ release: path.resolve(values.get('--release')), model, endpoint: endpoint.origin, gpuPolicy,
    out: values.has('--out') ? path.resolve(values.get('--out')) : null, visible: values.has('--visible') })
}

export function assertLocalAccountPath(file, { platform = process.platform, accountHome = os.userInfo().homedir } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix
  assert.ok(typeof file === 'string' && paths.isAbsolute(file), 'Local QA paths must be absolute')
  if (platform !== 'win32') return
  const relative = paths.relative(accountHome, file)
  assert.ok(/^[a-z]:\\/i.test(file) && !file.slice(2).includes(':') && !/[. ](?:\\|$)/.test(file)
    && relative && !paths.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..\\'),
  'Local QA paths must remain inside the actual Windows account before any filesystem access')
}

export function matchingLocalAnswers(rows, content) {
  assert.ok(Array.isArray(rows) && rows.length <= 1000)
  return rows.filter(row => row?.visible === true && typeof row.text === 'string' && row.text.includes(content.trim())).length
}

export function selectedModel(tags, requested) {
  assert.ok(Array.isArray(tags?.models) && tags.models.length <= 1024, 'Ollama must report a bounded installed model list')
  const matches = tags.models.filter(row => row?.name === requested || (!requested.includes(':') && row?.name === `${requested}:latest`))
  if (matches.length !== 1) prerequisite(`The selected local model ${requested} is absent or ambiguous. No model was downloaded or substituted.`)
  const found = matches[0]
  assert.match(found.digest || '', /^[0-9a-f]{64}$/i, 'The selected installed model needs its real content digest')
  return Object.freeze({ name: found.name, digest: found.digest, size: Number.isSafeInteger(found.size) ? found.size : null })
}

export function readOwnedJson(root, relative, maxBytes = 2 * 1024 * 1024) {
  const file = path.resolve(root, relative), delta = path.relative(root, file)
  assert.ok(delta && !path.isAbsolute(delta) && delta !== '..' && !delta.startsWith(`..${path.sep}`), 'Evidence must remain inside this owned profile')
  let current = root
  for (const part of ['', ...delta.split(path.sep).slice(0, -1)]) {
    if (part) current = path.join(current, part)
    const stat = fs.lstatSync(current)
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Evidence cannot traverse a redirected profile')
  }
  const before = fs.lstatSync(file)
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= maxBytes)
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    const opened = fs.fstatSync(fd)
    assert.equal(opened.dev, before.dev); assert.equal(opened.ino, before.ino); assert.equal(opened.size, before.size)
    const bytes = fs.readFileSync(fd)
    assert.equal(bytes.length, opened.size); assert.ok(bytes.length <= maxBytes)
    return { value: JSON.parse(bytes), json: bytes.toString('utf8'), bytes: bytes.length, sha256: sha256(bytes) }
  } finally { fs.closeSync(fd) }
}

export function readLocalThread(profile, stateRoot, id) {
  assert.match(id, ID)
  // The configured native state root is explicit input. Never guess a profile
  // basename, or use the operator's default state when that input is absent.
  assert.ok(typeof stateRoot === 'string' && path.isAbsolute(stateRoot))
  return readOwnedJson(profile, path.relative(profile, path.join(stateRoot, 'state', 'local-model-threads', `${id}.json`)))
}

export function assertLocalSourceInputs(inputs) {
  for (const input of inputs) {
    assert.match(input.sha256, /^[0-9a-f]{64}$/)
    assert.equal(sha256(fs.readFileSync(input.path)), input.sha256, 'The Local QA driver source changed during its journey')
  }
}

function eventsFor(packets, sessionId, turnId) {
  assert.ok(Array.isArray(packets) && packets.length <= 4096)
  return packets.filter(packet => packet.sessionId === sessionId && packet.event?.turnId === turnId).map(packet => packet.event)
}
function turnEvidence(proof, packets, saved) {
  assert.ok(typeof saved.json === 'string' && Buffer.byteLength(saved.json) <= 2 * 1024 * 1024)
  assert.equal(sha256(saved.json), saved.sha256)
  assert.deepEqual(JSON.parse(saved.json), saved.value)
  return { ...proof, savedSha256: saved.sha256, savedJson: saved.json,
    nativePackets: packets.filter(packet => packet.sessionId === proof.sessionId && packet.event?.turnId === proof.turnId) }
}
function receiptFor(saved, turnId, model, status) {
  assert.match(saved?.threadId || '', ID)
  assert.equal(saved.version, 1); assert.equal(saved.record?.model, model)
  assert.ok(Array.isArray(saved.record.messages))
  assert.equal(saved.record.turnReceipt?.version, 1)
  assert.equal(saved.record.turnReceipt.turnId, turnId)
  assert.equal(saved.record.turnReceipt.status, status)
  return saved.record
}
export function assertLocalToolTurn({ packets, saved, sessionId, turnId, model, file, content, prompt }) {
  assert.match(sessionId, ID); assert.match(turnId, ID)
  assert.ok(content.length >= 32 && !prompt.includes(content.trim()), 'The prompt must not disclose the hidden file nonce')
  const events = eventsFor(packets, sessionId, turnId)
  assert.equal(events.filter(event => event.type === 'turn_accepted').length, 1, 'Require real Local runtime acceptance')
  const terminal = events.filter(event => event.type === 'turn_completed')
  assert.equal(terminal.length, 1); assert.equal(terminal[0].status, 'success')
  const record = receiptFor(saved, turnId, model, 'success')
  assert.ok(events.every(event => !event.threadId || event.threadId === saved.threadId), 'Every native event must belong to the same persisted Local thread')
  const calls = events.filter(event => event.type === 'tool_call')
  assert.ok(calls.length > 0, 'An assistant reply without a real tool call cannot prove file access')
  assert.equal(new Set(calls.map(call => call.toolCallId)).size, calls.length, 'Native tool calls need distinct identities')
  assert.equal(events.filter(event => event.type === 'tool_result').length, calls.length, 'Every native tool output must have a matching call')
  for (const call of calls) {
    assert.ok(typeof call.toolCallId === 'string' && call.toolCallId.length > 0 && call.toolCallId.length <= 512)
    assert.ok(events.indexOf(events.find(event => event.type === 'turn_accepted')) < events.indexOf(call))
    assert.equal(call.tool, 'host.read_file'); assert.deepEqual(call.payload, { path: file })
  }
  const hits = calls.map(call => {
    const results = events.filter(event => event.type === 'tool_result' && event.toolCallId === call.toolCallId)
    assert.equal(results.length, 1); assert.equal(results[0].tool, call.tool); assert.equal(results[0].status, 'ok')
    assert.ok(events.indexOf(call) < events.indexOf(results[0]) && events.indexOf(results[0]) < events.indexOf(terminal[0]), 'Tool output must precede terminal success')
    const output = JSON.parse(results[0].text)
    assert.equal(output.path, file); assert.equal(output.content, content); assert.equal(output.bytes, Buffer.byteLength(content))
    assert.ok(record.messages.some(message => message.role === 'tool' && message.turnId === turnId
      && message.tool_name === 'host.read_file' && message.content === results[0].text), 'Persisted Local tool output must match the actual native event bytes')
    return { toolCallId: call.toolCallId, outputSha256: sha256(Buffer.from(output.content)) }
  })
  assert.ok(events.some(event => event.type === 'assistant_text' && event.text.includes(content.trim())), 'Native assistant output must contain the observed tool bytes')
  assert.ok(record.messages.some(message => message.role === 'assistant' && message.turnId === turnId && message.content.includes(content.trim())),
    'The saved assistant answer must contain the returned hidden nonce')
  assert.ok(record.messages.some(message => message.role === 'user' && message.turnId === turnId && message.content.includes(prompt)),
    'The saved turn must contain this exact requested file-read prompt')
  return { sessionId, threadId: saved.threadId, turnId, model, file, contentSha256: sha256(content), tools: hits }
}
export function assertLocalStoppedTurn({ packets, saved, sessionId, turnId, model, busy, stopAt, terminalAt }) {
  assert.equal(busy?.busy, true, 'Stop requires a fresh actual native busy observation')
  assert.equal(busy.closing, false)
  assert.ok(Number.isFinite(busy.at) && Number.isFinite(stopAt) && stopAt >= busy.at && stopAt - busy.at <= 2000)
  assert.ok(Number.isFinite(terminalAt) && terminalAt >= stopAt)
  const events = eventsFor(packets, sessionId, turnId)
  assert.equal(events.filter(event => event.type === 'turn_accepted').length, 1, 'The real Local runtime must accept exactly this turn before Stop')
  assert.match(sessionId, ID); assert.match(turnId, ID)
  assert.ok(events.every(event => !event.threadId || event.threadId === saved.threadId), 'Stop events must belong to the persisted thread')
  const terminal = events.filter(event => event.type === 'turn_completed')
  assert.equal(terminal.length, 1); assert.equal(terminal[0].status, 'interrupted')
  receiptFor(saved, turnId, model, 'interrupted')
  assert.ok(!events.some(event => event.type === 'tool_call'), 'The bounded Stop prompt grants no tool action')
  return { sessionId, threadId: saved.threadId, turnId, busyAt: busy.at, stopAt, terminalAt, status: 'interrupted' }
}
export function assertLocalCleanup(receipt, { platform = process.platform } = {}) {
  assert.equal(receipt?.quiescent, true, 'Native owner must prove an empty descendant set')
  assert.equal(receipt.started, true); assert.equal(receipt.exitedNormally, true); assert.equal(receipt.exitCode, 0)
  if (platform === 'linux') assert.equal(receipt.hadRemainingChildren, false, 'Linux must affirm that no child outlived the driver')
  else assert.notEqual(receipt.hadRemainingChildren, true, 'A child left running after the driver exited is a cleanup defect')
}

/* The Local proof has one deliberately narrow role. Keep this preflight tied
   to the selected Engine's recorded installation policy so a fixture cannot
   quietly broaden itself when a permission tier changes. This is test
   infrastructure only; it does not alter the product's policy or grant a
   runtime function. */
export function assertLocalToolPolicy({ engineRoot, servicesRoot, role, agentApiMode }) {
  if (typeof engineRoot !== 'string' || typeof servicesRoot !== 'string') throw new Error('LOCAL_QA_POLICY_INPUT_INVALID')
  if (agentApiMode !== 'Only') throw Object.assign(new Error('The Local proof requires Agent API Only.'), { code: 'LOCAL_QA_AGENT_API_REQUIRED' })
  if (!role || !Array.isArray(role.functions) || role.functions.length !== 1 || role.functions[0] !== 'host.read_file'
      || role.requiresDirectUserAuthorization !== true) {
    throw Object.assign(new Error('The Local proof role must authorize exactly host.read_file for the person.'), { code: 'LOCAL_QA_ROLE_INVALID' })
  }
  const require = createRequire(import.meta.url)
  const machine = require(path.join(engineRoot, 'src/lib/setup/machine-record.js'))
  const policy = require(path.join(engineRoot, 'src/lib/permission-tier-policy.js'))
  const registry = require(path.join(engineRoot, 'src/lib/tool-registry.js'))
  const record = machine.readMachineRecord({ servicesRoot, adopt: false })
  const installTier = policy.installTierFromRecord(record)
  const allowed = policy.allowedToolNames(registry.TOOL_REGISTRY, policy.installTierSessionFromRecord(record))
  if (!allowed.includes('host.read_file')) {
    throw Object.assign(new Error('The selected permission tier excludes host.read_file.'), { code: 'PERMISSION_CONFINED_EXCLUSION_REFUSED' })
  }
  return Object.freeze({ installTier, agentApiMode, functions: Object.freeze([...role.functions]) })
}

// All mutations below are actual CDP control input. Renderer evaluation only
// reads UI/bridge state or subscribes to the native event stream; it never
// replaces a bridge, seeds a node or sends/intercepts a provider request.
export async function runLocalNativeJourney({ window, configuration, readThread, record, now = () => Date.now(), pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const { model, file, content, roleId = LOCAL_QA_ROLE } = configuration
  const evaluate = async expression => {
    const value = await window.evaluate(expression)
    if (value?.__evaluateThrew) throw new Error(value.__evaluateThrew)
    return value
  }
  const wait = async (label, read, accept, timeoutMs = LOCAL_QA_LIMIT_MS) => {
    const deadline = now() + timeoutMs
    while (now() < deadline) { const value = await read(); if (accept(value)) return value; await pause(150) }
    throw new Error(`Native Local journey timed out: ${label}`)
  }
  const click = async selector => { assert.equal(await window.clickVisible(selector), 'clicked', `Native control was not pressable: ${selector}`) }
  const type = async (selector, text) => { assert.equal(await window.typeInto(selector, text), 'typed', `Native text input did not retain exact bytes: ${selector}`) }
  const key = async (name, code) => { for (const type of ['rawKeyDown', 'keyUp']) await window.session.send('Input.dispatchKeyEvent', { type, key: name, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code }) }
  const choose = async (selector, desired) => {
    const options = await evaluate(`Array.from(document.querySelector(${JSON.stringify(selector)})?.options || []).map(o => ({value:o.value,disabled:o.disabled}))`)
    assert.equal(options.filter(option => option.value === desired && !option.disabled).length, 1, `Required native choice is unavailable: ${desired}`)
    await click(selector); await key('Escape', 27); await key('Home', 36)
    for (let i = 0; i <= options.length; i++) {
      if (await evaluate(`document.querySelector(${JSON.stringify(selector)})?.value`) === desired) return
      await key('ArrowDown', 40)
    }
    throw new Error(`Native keyboard selection could not reach ${desired}`)
  }
  const nodes = () => evaluate(`(() => {const value=localStorage.getItem('mc.fleet.trees.v1:this-computer');return value?JSON.parse(value).nodes:[]})()`)
  const packets = () => evaluate(`(() => {if(window.__localNativeQa.overflow)throw new Error('Native event evidence overflow');return window.__localNativeQa.events})()`)
  const activity = sessionId => evaluate(`window.mcAgent.sessionActivity({sessionId:${JSON.stringify(sessionId)}})`)
  const targetUrl = new URL(await evaluate('location.href')); targetUrl.hash = '/computers'
  await window.session.send('Page.navigate', { url: targetUrl.href })
  await wait('native bridge', () => evaluate('Boolean(window.mcAgent && window.mcSettings)'), Boolean)
  await evaluate(`(() => {if(window.__localNativeQa)throw new Error('Evidence listener already exists');
    const state={events:[],bytes:0,overflow:false};window.__localNativeQa=state;
    state.detach=window.mcAgent.onEvent(packet=>{const text=JSON.stringify(packet);state.bytes+=text.length;
      if(state.events.length>=4096||state.bytes>1048576){state.overflow=true;return}state.events.push(JSON.parse(text))});return true})()`)
  const initial = await nodes(); assert.deepEqual(initial, [], 'This journey requires its own initially empty tree')
  const firstPrompt = `Use only host.read_file to read the entire file at this exact path: ${file}\nReply with its exact contents. Do not guess, edit files, delegate or call any other tool.`
  assert.ok(!firstPrompt.includes(content.trim()))
  await click('.tree-chat-add')
  await click('.tree-new-tree')
  await wait('compose model selector', () => evaluate('Boolean(document.querySelector(\'[data-compose-field="tier"] option[value="local"]:not(:disabled)\'))'), Boolean, 60000)
  await choose('[data-compose-field="role"]', roleId)
  await choose('[data-compose-field="tier"]', 'local')
  await type('[data-compose-field="message"]', firstPrompt)
  await click('[data-compose-action="start"]')
  const node = await wait('one started Local tree node', nodes, rows => rows.length === 1 && Boolean(rows[0].sessionId))
  assert.equal(node.length, 1); const owned = node[0]; assert.equal(owned.tier, 'local')
  const sessionId = owned.sessionId
  const nativeTurn = async (after = new Set()) => wait('new actual Local runtime acceptance', packets, values => values.some(packet => packet.sessionId === sessionId
    && packet.event.type === 'turn_accepted' && !after.has(packet.event.turnId)))
  const accepted = await nativeTurn(); const firstTurn = accepted.find(packet => packet.sessionId === sessionId && packet.event.type === 'turn_accepted').event.turnId
  const finish = turnId => wait('actual native terminal event', packets, values => values.some(packet => packet.sessionId === sessionId && packet.event.turnId === turnId && packet.event.type === 'turn_completed'))
  const firstEvents = await finish(firstTurn)
  const threadId = firstEvents.find(packet => packet.sessionId === sessionId && packet.event.turnId === firstTurn && packet.event.threadId)?.event.threadId
  assert.match(threadId || '', ID)
  const firstSaved = await readThread(threadId)
  const first = assertLocalToolTurn({ packets: firstEvents, saved: firstSaved.value, sessionId, turnId: firstTurn, model, file, content, prompt: firstPrompt })
  await record('first-tool-turn', turnEvidence(first, firstEvents, firstSaved))
  const nodeSelector = `.static-tree-node[data-agent-id="${owned.id}"]`
  const box = `${nodeSelector} .tree-box-chat`
  if ((await window.visibility(box))?.state === 'visible') await click(box)
  else {
    const point = await window.waitForVisible(nodeSelector); assert.equal(point?.state, 'visible')
    for (const clickCount of [1, 2]) for (const type of ['mousePressed', 'mouseReleased']) await window.session.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount })
  }
  const chat = `.tree-conversation[data-agent-id="${owned.id}"]`, input = `${chat} .chat-input input`
  await wait('chat input', () => window.visibility(input), value => value?.state === 'visible', 15000)
  const visibleAnswers = async () => matchingLocalAnswers(await evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(chat + ' .msg:not(.me):not(.note):not(.context) .chat-msg-text')})).map(node => ({text:node.textContent,visible:node.getBoundingClientRect().height > 0}))`), content)
  await wait('rendered first assistant answer', visibleAnswers, count => count > 0, 15000)
  const seen = new Set(firstEvents.filter(packet => packet.sessionId === sessionId).map(packet => packet.event.turnId))
  const stopPrompt = 'Without tools, count integers from 1 through 2000, one integer per line. Continue until you reach 2000.'
  await type(input, stopPrompt); await click(`${chat} .chat-send`)
  const stopEvents = await nativeTurn(seen)
  const stopTurn = stopEvents.find(packet => packet.sessionId === sessionId && packet.event.type === 'turn_accepted' && !seen.has(packet.event.turnId)).event.turnId
  const observed = await activity(sessionId)
  assert.equal(observed?.ok, true); const busy = { ...observed, at: now() }
  assert.equal(busy.busy, true, 'The Stop turn completed before it could be exercised; no retry can manufacture a pass')
  const stopAt = now(); await click(`${chat} [data-chat-chip="halt"]`)
  const haltedEvents = await finish(stopTurn), terminalAt = now()
  await wait('native busy clears after interruption', () => activity(sessionId), value => value?.ok === true && value.busy === false)
  const stoppedSaved = await readThread(threadId)
  const stopped = assertLocalStoppedTurn({ packets: haltedEvents, saved: stoppedSaved.value, sessionId, turnId: stopTurn, model, busy, stopAt, terminalAt })
  await record('stopped-turn', turnEvidence(stopped, haltedEvents, stoppedSaved))
  const laterPrompt = `Again use only host.read_file to read this entire exact path: ${file}\nReply with its exact contents and no other text.`
  const previousAnswers = await visibleAnswers()
  const laterAt = now(); assert.ok(laterAt >= terminalAt)
  await type(input, laterPrompt); await key('Enter', 13)
  const prior = new Set([firstTurn, stopTurn]); const laterEvents = await nativeTurn(prior)
  const laterTurn = laterEvents.find(packet => packet.sessionId === sessionId && packet.event.type === 'turn_accepted' && !prior.has(packet.event.turnId)).event.turnId
  const completed = await finish(laterTurn), laterSaved = await readThread(threadId)
  const later = assertLocalToolTurn({ packets: completed, saved: laterSaved.value, sessionId, turnId: laterTurn, model, file, content, prompt: laterPrompt })
  await wait('rendered later assistant answer', visibleAnswers, count => count > previousAnswers, 15000)
  await record('later-tool-turn', turnEvidence({ ...later, enteredAt: laterAt }, completed, laterSaved))
  const finalNodes = await nodes(); assert.equal(finalNodes.length, 1); assert.equal(finalNodes[0].id, owned.id); assert.equal(finalNodes[0].sessionId, sessionId)
  await evaluate('window.__localNativeQa.detach(); true')
  return { nodeId: owned.id, treeId: owned.treeId, sessionId, threadId, first, stopped, later, transcriptSha256: laterSaved.sha256 }
}
