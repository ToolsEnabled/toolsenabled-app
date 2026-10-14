/* "SET UP LOCAL MODELS": THE POPUP SHOWS ONLY THE STEPS STILL NEEDED.
 *
 * src/local-setup-popup.js is driven here by value, through the
 * same DOM stand-in the other dialog suites use, against a fake bridge that
 * answers each state shell/local-model-setup.cjs can report:
 *   not installed, installed but not running, running with no model, running
 *   with models, a model downloading (progress, error, disk full, cancel),
 *   the Windows installer waiting for its press, ready, and the states no
 *   button can fix (another computer, an unusable address).
 * What the popup writes is asserted too: the address and the default model go
 * through mcSettings.setMany, the Settings page's own writer, and nothing loads
 * a model.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { findingsInText } from '../check-plain-language.mjs'
import { LOCAL_SETUP_POPUP as COPY } from '../../src/local-model-setup-copy.js'
import {
  formatBytes, localSetupNeeded, localSetupPlan, offersLocalSetup, openLocalModelSetup, openLocalModelSetupUntilClosed, setupSentence,
} from '../../src/local-setup-popup.js'

const GiB = 1024 ** 3
const MiB = 1024 ** 2
const ADDRESS = 'http://127.0.0.1:11500'

const settle = async (turns = 12) => { for (let index = 0; index < turns; index += 1) await new Promise(resolve => setImmediate(resolve)) }

function statusOf(overrides = {}) {
  return {
    ok: true,
    platform: 'linux',
    isolated: false,
    address: { url: ADDRESS, host: '127.0.0.1', port: 11500, saved: true, usable: true, local: true },
    provider: 'Ollama',
    savedEndpoint: ADDRESS,
    gpuPolicy: 'Require GPU',
    installed: false,
    appCopy: false,
    running: false,
    answering: 'no',
    version: null,
    startedHere: false,
    models: [],
    held: [],
    recommended: 'qwen2.5:7b-instruct',
    chosen: { model: null, installed: false, name: null, saved: false },
    ready: false,
    readyCode: null,
    hardware: { ramBytes: 46 * GiB, freeRamBytes: 30 * GiB, vramBytes: 8188 * MiB, freeVramBytes: 7000 * MiB, gpuName: 'NVIDIA GeForce RTX 4070 Laptop GPU', freeDiskBytes: 50e9 },
    catalogue: [
      { id: 'qwen2.5:0.5b-instruct', label: 'Qwen 2.5 0.5B Instruct', downloadBytes: 397821319, needBytes: GiB, downloaded: false, fit: 'gpu', tight: false },
      { id: 'qwen2.5:3b-instruct', label: 'Qwen 2.5 3B Instruct', downloadBytes: 1929912432, needBytes: 3 * GiB, downloaded: false, fit: 'gpu', tight: false },
      { id: 'qwen2.5:7b-instruct', label: 'Qwen 2.5 7B Instruct', downloadBytes: 4683087332, needBytes: 6 * GiB, downloaded: false, fit: 'gpu', tight: false },
      { id: 'llama3.1:8b', label: 'Llama 3.1 8B Instruct', downloadBytes: 4920753328, needBytes: 7 * GiB, downloaded: false, fit: 'too-big', tight: false },
    ],
    installSupported: true,
    installKind: 'tar.zst',
    installerReady: false,
    activity: { install: null, pull: null },
    ...overrides,
  }
}

function fakeBridge(initial) {
  let status = initial
  const calls = []
  const listeners = new Set()
  const answers = {}
  const bridge = {
    calls,
    listeners,
    answers,
    set(next) { status = next },
    emit(packet) { for (const listener of [...listeners]) listener(packet) },
    localSetupStatus: async () => { calls.push(['status']); return structuredClone(status) },
    localSetupInstall: async () => { calls.push(['install']); return answers.install || { ok: true, started: true } },
    localSetupCancelInstall: async () => { calls.push(['cancel-install']); return { ok: true, cancelled: true } },
    localSetupRunInstaller: async () => { calls.push(['run-installer']); return answers.runInstaller || { ok: true, started: true } },
    localSetupStart: async () => { calls.push(['start']); return answers.start || { ok: true, running: true, startedHere: true } },
    localSetupStop: async () => { calls.push(['stop']); return { ok: true } },
    localSetupPull: async request => { calls.push(['pull', request]); return answers.pull || { ok: true, started: true, model: request.model } },
    localSetupCancelPull: async () => { calls.push(['cancel-pull']); return { ok: true, cancelled: true } },
    localSetupCheck: async () => { calls.push(['check']); return { ok: true, ready: status.ready } },
    onLocalSetupEvent: listener => { listeners.add(listener); return () => listeners.delete(listener) },
  }
  return bridge
}

function fakeSettings(bridge, after) {
  const writes = []
  return {
    writes,
    setMany: async items => {
      writes.push(items)
      if (typeof after === 'function') return after(items)
      bridge.set(statusOf({
        installed: true, running: true, answering: 'yes', models: [items.find(item => item.id === 'model.local_agent_name').value],
        chosen: { model: items[2].value, installed: true, name: items[2].value, saved: true }, ready: true,
      }))
      return { ok: true, results: items.map(item => ({ id: item.id, ok: true, value: item.value })) }
    },
  }
}

function mount(t, bridge, options = {}) {
  const dom = installDomStandIn()
  t.after(() => dom.restore())
  const opener = dom.document.createElement('button')
  dom.document.body.appendChild(opener)
  opener.focus()
  const settings = options.settings || fakeSettings(bridge)
  const readies = []
  const closes = []
  const popup = openLocalModelSetup({
    document: dom.document, host: dom.document.body, bridge, settings,
    reason: options.reason || '',
    onReady: status => readies.push(status),
    onClose: result => closes.push(result),
  })
  t.after(() => popup?.close())
  return { dom, popup, settings, readies, closes, opener, root: popup.root }
}

const view = root => root.getAttribute('data-local-setup-view')
const action = (root, name) => root.querySelector(`[data-local-setup-action="${name}"]`)
const steps = root => root.querySelectorAll('[data-local-setup-step]').map(step => ({
  step: step.getAttribute('data-local-setup-step'),
  state: step.className.replace('local-setup-step is-', ''),
  name: step.querySelector('.local-setup-step-name').textContent,
}))
const statusLine = root => root.querySelector('[data-local-setup-status]').textContent
const actionNames = root => root.querySelector('[data-local-setup-actions]').querySelectorAll('button').map(button => button.getAttribute('data-local-setup-action'))
/* Model ids carry a colon, which the stand-in's selectors do not take; rows
   are found by reading the attribute instead. */
const byAttr = (root, name, value) => root.querySelectorAll(`[${name}]`).find(node => node.getAttribute(name) === value) || null
const pickInput = (root, id) => byAttr(root, 'data-local-setup-pick', id)
const modelRow = (root, id) => byAttr(root, 'data-local-setup-model', id)
function pick(root, id) {
  const input = pickInput(root, id)
  assert.ok(input, `a row for ${id}`)
  input.checked = true
  input.dispatch('change')
}

/* ================================================= which steps are shown */

test('only the steps this computer still needs are planned', () => {
  assert.deepEqual(localSetupPlan(statusOf()).steps, ['install', 'start', 'choose', 'finish'])
  assert.deepEqual(localSetupPlan(statusOf({ installed: true })).steps, ['start', 'choose', 'finish'])
  assert.deepEqual(localSetupPlan(statusOf({ installed: true, running: true })).steps, ['choose', 'finish'])
  assert.deepEqual(localSetupPlan(statusOf({ running: true, chosen: { model: 'm', installed: true, name: 'm', saved: false } })).steps, ['finish'],
    'a model that is already here only needs saving')
  assert.deepEqual(localSetupPlan(statusOf({ running: true, ready: true })).steps, [])
  assert.equal(localSetupPlan(statusOf({ address: { url: 'http://10.0.0.2:11434', usable: true, local: false } })).blocker, 'remote')
  assert.equal(localSetupPlan(statusOf({ address: { url: 'localhost:11434', usable: false, local: false } })).blocker, 'unusable')
  assert.equal(localSetupPlan(statusOf({ installSupported: false })).blocker, 'unsupported')
  assert.deepEqual(localSetupPlan(statusOf({ platform: 'win32', installSupported: false, installerReady: true })).steps, ['install', 'start', 'choose', 'finish'])
  assert.deepEqual(localSetupPlan(null).steps, [])
})

test('the refusals this popup is the way out of', () => {
  assert.equal(offersLocalSetup('LOCAL_NODE_RUNTIME_UNAVAILABLE'), true)
  assert.equal(offersLocalSetup('LOCAL_NODE_MODEL_NOT_INSTALLED'), true)
  assert.equal(offersLocalSetup('AGENT_SESSION_FAILED'), false)
  assert.equal(offersLocalSetup(undefined), false)
  assert.equal(formatBytes(397821319), '398 MB')
  assert.equal(formatBytes(1427391999), '1.4 GB')
})

/* =================================================== not installed */

test('nothing installed: four steps, Download Ollama first, then progress, then the next step', async t => {
  const bridge = fakeBridge(statusOf())
  const { root, popup } = mount(t, bridge)
  assert.equal(root.open, true, 'the popup opens as a modal dialog')
  assert.equal(view(root), 'checking')
  await popup.ready
  assert.equal(view(root), 'install')
  assert.deepEqual(steps(root).map(step => step.name), ['Get Ollama', 'Start Ollama', 'Choose a model', 'Ready'])
  assert.equal(steps(root)[0].state, 'current')
  assert.equal(root.ownerDocument.activeElement, action(root, 'install'), 'the one thing to press has the keyboard')
  assert.equal(action(root, 'install').textContent, COPY.installButton)
  assert.deepEqual(actionNames(root), ['install', 'check', 'close'], 'Check again is there for an Ollama installed another way')
  assert.ok(root.textContent.includes(COPY.installHow.linux))

  action(root, 'install').click()
  await settle()
  assert.deepEqual(bridge.calls.at(-1), ['install'])
  bridge.emit({ kind: 'install', phase: 'download', received: 700e6, total: 1400e6, version: 'v0.34.3' })
  await settle()
  assert.equal(root.querySelector('[data-local-setup-progress]').getAttribute('value'), '500')
  assert.equal(root.querySelector('[data-local-setup-progress-line]').textContent, 'Downloading Ollama: 700 MB of 1.4 GB.')
  assert.ok(action(root, 'cancel-install'), 'a running download can be cancelled')
  bridge.emit({ kind: 'install', phase: 'download', received: 1050e6, total: 1400e6 })
  await settle()
  assert.equal(root.querySelector('[data-local-setup-progress]').getAttribute('value'), '750', 'progress repaints in place')
  bridge.emit({ kind: 'install', phase: 'verify', received: 1400e6, total: 1400e6 })
  await settle()
  assert.equal(root.querySelector('[data-local-setup-progress-line]').textContent, COPY.verifying)

  bridge.set(statusOf({ installed: true, appCopy: true }))
  bridge.emit({ kind: 'install', phase: 'done', version: 'v0.34.3' })
  await settle()
  assert.equal(view(root), 'start')
  assert.equal(statusLine(root), 'Ollama v0.34.3 is installed.')
  assert.deepEqual(steps(root).map(step => step.state), ['done', 'current', 'next', 'next'])
})

test('a failed or cancelled Ollama download says what to do and offers the button again', async t => {
  const bridge = fakeBridge(statusOf())
  const { root, popup } = mount(t, bridge)
  await popup.ready
  action(root, 'install').click()
  await settle()
  action(root, 'cancel-install').click()
  await settle()
  assert.deepEqual(bridge.calls.at(-1), ['cancel-install'])
  bridge.emit({ kind: 'install', phase: 'failed', code: 'LOCAL_SETUP_CHECKSUM_MISMATCH' })
  await settle()
  assert.equal(view(root), 'install')
  assert.equal(statusLine(root), COPY.refusals.LOCAL_SETUP_CHECKSUM_MISMATCH)
  assert.ok(action(root, 'install'))
  bridge.emit({ kind: 'install', phase: 'failed', code: 'LOCAL_SETUP_DISK_FULL', needBytes: 6e9, freeBytes: 2e9 })
  await settle()
  assert.equal(statusLine(root), 'There is not enough free space: this needs 6.0 GB and 2.0 GB is free. Free some space, then try again.')
})

/* =================================================== installed, not running */

test('installed but not answering: only Start is asked for, and the model step follows', async t => {
  const bridge = fakeBridge(statusOf({ installed: true }))
  const { root, popup } = mount(t, bridge)
  await popup.ready
  assert.equal(view(root), 'start')
  assert.deepEqual(steps(root).map(step => step.step), ['start', 'choose', 'finish'], 'Get Ollama is not shown when Ollama is here')
  assert.ok(root.textContent.includes(COPY.startLead(ADDRESS)))
  bridge.set(statusOf({ installed: true, running: true, answering: 'yes', startedHere: true }))
  action(root, 'start').click()
  await settle()
  assert.deepEqual(bridge.calls.filter(call => call[0] === 'start'), [['start']])
  assert.equal(view(root), 'choose')
  assert.equal(statusLine(root), COPY.startedHere)
})

test('a start that fails names the fix, and what Ollama said', async t => {
  const bridge = fakeBridge(statusOf({ installed: true }))
  bridge.answers.start = { ok: false, code: 'LOCAL_SETUP_PORT_IN_USE' }
  const { root, popup } = mount(t, bridge)
  await popup.ready
  action(root, 'start').click()
  await settle()
  assert.equal(view(root), 'start')
  assert.equal(statusLine(root), COPY.refusals.LOCAL_SETUP_PORT_IN_USE)
  bridge.answers.start = { ok: false, code: 'LOCAL_SETUP_START_FAILED', detail: 'Error: could not create directory the ToolsEnabled folder/models: permission denied' }
  action(root, 'start').click()
  await settle()
  assert.equal(statusLine(root), `${COPY.refusals.LOCAL_SETUP_START_FAILED} ${COPY.ollamaSaid('Error: could not create directory the ToolsEnabled folder/models: permission denied')}`)
})

/* =================================================== choosing a model */

test('running with no model: the list says size and fit, suggests one that fits the card, and refuses a too-large one', async t => {
  const tight = statusOf({ installed: true, running: true })
  tight.catalogue[2].tight = true
  const bridge = fakeBridge(tight)
  const { root, popup } = mount(t, bridge)
  await popup.ready
  assert.equal(view(root), 'choose')
  assert.deepEqual(steps(root).map(step => step.step), ['choose', 'finish'])
  assert.ok(root.textContent.includes('This computer has 49.4 GB of memory and NVIDIA GeForce RTX 4070 Laptop GPU with 8.6 GB.'))
  const rows = root.querySelectorAll('[data-local-setup-model]')
  assert.deepEqual(rows.map(row => row.getAttribute('data-local-setup-model')), ['qwen2.5:0.5b-instruct', 'qwen2.5:3b-instruct', 'qwen2.5:7b-instruct', 'llama3.1:8b'])
  const suggested = pickInput(root, 'qwen2.5:7b-instruct')
  assert.equal(suggested.hasAttribute('checked'), true, 'the suggested model is picked to start with')
  assert.ok(modelRow(root, 'qwen2.5:7b-instruct').querySelector('[data-local-setup-recommended]'))
  assert.ok(modelRow(root, 'qwen2.5:7b-instruct').querySelector('[data-local-setup-tight]'), 'a need close to free memory is marked')
  assert.ok(modelRow(root, 'qwen2.5:0.5b-instruct').textContent.includes('398 MB download · Fits your graphics card'))
  assert.equal(pickInput(root, 'llama3.1:8b').hasAttribute('disabled'), true, 'a model too large for this computer cannot be picked')
  assert.equal(action(root, 'download').textContent, COPY.downloadButton)
})

test('download and use: the pull runs through Ollama with progress, then the address and model are saved and checked', async t => {
  const bridge = fakeBridge(statusOf({ installed: true, running: true }))
  const { root, popup, settings, readies } = mount(t, bridge)
  await popup.ready
  pick(root, 'qwen2.5:0.5b-instruct')
  action(root, 'download').click()
  await settle()
  assert.deepEqual(bridge.calls.find(call => call[0] === 'pull'), ['pull', { model: 'qwen2.5:0.5b-instruct' }])
  assert.equal(pickInput(root, 'qwen2.5:3b-instruct').hasAttribute('disabled'), true, 'the list holds still while downloading')
  bridge.emit({ kind: 'pull', model: 'qwen2.5:0.5b-instruct', phase: 'progress', completed: 199e6, total: 398e6, status: 'pulling' })
  await settle()
  assert.equal(root.querySelector('[data-local-setup-progress]').getAttribute('value'), '500')
  assert.equal(root.querySelector('[data-local-setup-progress-line]').textContent, 'Downloading Qwen 2.5 0.5B Instruct: 199 MB of 398 MB.')
  const done = statusOf({ installed: true, running: true, models: ['qwen2.5:0.5b-instruct'] })
  done.catalogue[0].downloaded = true
  bridge.set(done)
  bridge.emit({ kind: 'pull', model: 'qwen2.5:0.5b-instruct', phase: 'done', completed: 398e6, total: 398e6 })
  await settle(30)
  assert.deepEqual(settings.writes, [[
    { id: 'model.provider', value: 'Ollama' },
    { id: 'model.endpoint', value: ADDRESS },
    { id: 'model.local_agent_name', value: 'qwen2.5:0.5b-instruct' },
  ]], 'saved through the Settings page\'s own writer, and nothing else')
  assert.equal(view(root), 'ready')
  assert.equal(root.querySelector('[data-local-setup-ready]').textContent, COPY.ready('qwen2.5:0.5b-instruct', ADDRESS))
  assert.equal(readies.length, 1)
  assert.equal(bridge.calls.some(call => ['start', 'install'].includes(call[0])), false)
})

test('a model download that is cancelled, refused for space or stopped by Ollama says so and can be pressed again', async t => {
  const bridge = fakeBridge(statusOf({ installed: true, running: true }))
  const { root, popup } = mount(t, bridge)
  await popup.ready
  action(root, 'download').click()
  await settle()
  action(root, 'cancel-pull').click()
  await settle()
  assert.deepEqual(bridge.calls.at(-1), ['cancel-pull'])
  bridge.emit({ kind: 'pull', model: 'qwen2.5:7b-instruct', phase: 'cancelled', code: 'LOCAL_SETUP_CANCELLED' })
  await settle()
  assert.equal(view(root), 'choose')
  assert.equal(statusLine(root), COPY.refusals.LOCAL_SETUP_CANCELLED)
  assert.ok(action(root, 'download'))

  action(root, 'download').click()
  await settle()
  bridge.emit({ kind: 'pull', model: 'qwen2.5:7b-instruct', phase: 'failed', code: 'LOCAL_SETUP_PULL_DISK_FULL', detail: 'no space left on device' })
  await settle()
  assert.equal(statusLine(root), `${COPY.refusals.LOCAL_SETUP_PULL_DISK_FULL} ${COPY.ollamaSaid('no space left on device')}`)

  bridge.answers.pull = { ok: false, code: 'LOCAL_SETUP_DISK_FULL', needBytes: 5.2e9, freeBytes: 1.1e9 }
  action(root, 'download').click()
  await settle()
  assert.equal(statusLine(root), 'There is not enough free space: this needs 5.2 GB and 1.1 GB is free. Free some space, then try again.')
})

test('a model already on this computer is used without downloading; a processor model allows the processor as it saves', async t => {
  const bridge = fakeBridge(statusOf({
    installed: true, running: true, models: ['qwen3.5:9b', 'tinyllama:latest'],
    held: [
      { id: 'qwen3.5:9b', label: 'qwen3.5:9b', sizeBytes: 6594474711, fit: 'gpu', tight: false, listed: false },
      { id: 'tinyllama:latest', label: 'tinyllama:latest', sizeBytes: 637700138, fit: 'cpu', tight: false, listed: false },
    ],
  }))
  const { root, popup, settings } = mount(t, bridge)
  await popup.ready
  assert.ok(root.querySelector('[data-local-setup-held]').textContent.includes(COPY.heldHeading))
  pick(root, 'qwen3.5:9b')
  assert.equal(action(root, 'use').textContent, COPY.useButton)
  pick(root, 'tinyllama:latest')
  assert.ok(root.querySelector('[data-local-setup-cpu]'), 'the processor note is shown before pressing')
  action(root, 'use').click()
  await settle(30)
  assert.equal(bridge.calls.some(call => call[0] === 'pull'), false)
  assert.deepEqual(settings.writes[0].at(-1), { id: 'model.local_gpu_policy', value: 'Allow CPU fallback' })
})

test('a save the settings writer refuses leaves the popup on the last step with the reason', async t => {
  const bridge = fakeBridge(statusOf({ running: true, chosen: { model: 'qwen2.5:3b-instruct', installed: true, name: 'qwen2.5:3b-instruct', saved: false }, provider: 'OpenAI compatible', savedEndpoint: 'https://api.example.com' }))
  const settings = fakeSettings(bridge, items => ({ ok: false, results: items.map(item => ({ id: item.id, ok: false })) }))
  const { root, popup } = mount(t, bridge, { settings })
  await popup.ready
  assert.equal(view(root), 'finish')
  assert.deepEqual(steps(root).map(step => step.step), ['finish'], 'one step: the model is already here')
  assert.ok(root.querySelector('[data-local-setup-replaces]').textContent.includes('OpenAI compatible at https://api.example.com'), 'replacing another service is said before pressing')
  action(root, 'finish').click()
  await settle(30)
  assert.equal(view(root), 'finish')
  assert.equal(statusLine(root), COPY.saveRefused)
})

test('saved but a Local agent still cannot start: the engine\'s reason is shown, not "ready"', async t => {
  const bridge = fakeBridge(statusOf({ running: true, chosen: { model: 'qwen2.5:3b-instruct', installed: true, name: 'qwen2.5:3b-instruct', saved: false } }))
  const settings = fakeSettings(bridge, items => {
    bridge.set(statusOf({ running: true, chosen: { model: 'qwen2.5:3b-instruct', installed: true, name: 'qwen2.5:3b-instruct', saved: true }, ready: false, readyCode: 'LOCAL_NODE_SETTINGS_INVALID' }))
    return { ok: true, results: items.map(item => ({ id: item.id, ok: true })) }
  })
  const { root, popup, readies } = mount(t, bridge, { settings })
  await popup.ready
  action(root, 'finish').click()
  await settle(30)
  assert.equal(view(root), 'finish')
  assert.equal(statusLine(root), COPY.refusals.LOCAL_NODE_SETTINGS_INVALID)
  assert.equal(readies.length, 0)
})

/* =================================================== ready, Windows, blockers */

test('already ready: no steps, the model in use, and a way to choose another', async t => {
  const bridge = fakeBridge(statusOf({ installed: true, running: true, models: ['qwen2.5:3b-instruct'], chosen: { model: 'qwen2.5:3b-instruct', installed: true, name: 'qwen2.5:3b-instruct', saved: true }, ready: true }))
  const { root, popup } = mount(t, bridge)
  await popup.ready
  assert.equal(view(root), 'ready')
  assert.deepEqual(steps(root), [])
  assert.equal(root.querySelector('[data-local-setup-ready]').textContent, COPY.alreadyReady('qwen2.5:3b-instruct', ADDRESS))
  action(root, 'another').click()
  await settle()
  assert.equal(view(root), 'choose')
  assert.deepEqual(steps(root).map(step => step.step), ['choose', 'finish'])
})

/* The Ollama this app started keeps running when its log file cannot be
   written (shell/local-model-setup.cjs keeps the reason as logProblem); the
   popup says the log is not being saved, on the steps shown after a start. */
const startedReady = logProblem => statusOf({
  installed: true, appCopy: true, running: true, answering: 'yes', startedHere: true, logProblem,
  models: ['qwen2.5:3b-instruct'], chosen: { model: 'qwen2.5:3b-instruct', installed: true, name: 'qwen2.5:3b-instruct', saved: true }, ready: true,
})

test('a started Ollama whose disk is full for its log: ready says the log is not being saved, and so does the model list', async t => {
  const { root, popup } = mount(t, fakeBridge(startedReady('LOCAL_SETUP_LOG_DISK_FULL')))
  await popup.ready
  assert.equal(view(root), 'ready')
  assert.equal(root.querySelector('[data-local-setup-log]')?.textContent, COPY.logUnsaved.LOCAL_SETUP_LOG_DISK_FULL)
  action(root, 'another').click()
  await settle()
  assert.equal(view(root), 'choose')
  assert.equal(root.querySelector('[data-local-setup-log]')?.textContent, COPY.logUnsaved.LOCAL_SETUP_LOG_DISK_FULL)
})

test('a started Ollama whose log file cannot be written for another reason says that', async t => {
  const { root, popup } = mount(t, fakeBridge(startedReady('LOCAL_SETUP_LOG_WRITE_FAILED')))
  await popup.ready
  assert.equal(root.querySelector('[data-local-setup-log]')?.textContent, COPY.logUnsaved.LOCAL_SETUP_LOG_WRITE_FAILED)
})

test('a started Ollama whose log is being saved gets no log sentence', async t => {
  const { root, popup } = mount(t, fakeBridge(startedReady(null)))
  await popup.ready
  assert.equal(view(root), 'ready')
  assert.equal(root.querySelector('[data-local-setup-log]'), null)
})

test('Windows: after the checked download the installer runs only on its own button', async t => {
  const bridge = fakeBridge(statusOf({ platform: 'win32', installKind: 'installer', installerReady: true }))
  const { root, popup } = mount(t, bridge)
  await popup.ready
  assert.equal(view(root), 'install')
  assert.ok(root.textContent.includes(COPY.installHow.win32))
  assert.deepEqual(actionNames(root), ['run-installer', 'check', 'close'])
  assert.equal(bridge.calls.some(call => call[0] === 'run-installer'), false, 'opening the popup runs nothing')
  action(root, 'run-installer').click()
  await settle()
  assert.deepEqual(bridge.calls.at(-1), ['run-installer'])
  assert.equal(root.querySelector('[data-local-setup-installer]').textContent, COPY.installerRunning)
  bridge.set(statusOf({ platform: 'win32', installed: true }))
  bridge.emit({ kind: 'installer', phase: 'done', code: null })
  await settle()
  assert.equal(view(root), 'start')
})

test('another computer, an unusable address, or no download for this computer: the popup says what to do instead', async t => {
  for (const [status, expected] of [
    [statusOf({ address: { url: 'http://10.0.0.2:11434', usable: true, local: false } }), COPY.remote('http://10.0.0.2:11434')],
    [statusOf({ address: { url: 'localhost:11434', usable: false, local: false } }), COPY.unusable('localhost:11434')],
    [statusOf({ installSupported: false }), COPY.installUnsupported],
  ]) {
    const bridge = fakeBridge(status)
    const { root, popup } = mount(t, bridge)
    await popup.ready
    assert.equal(root.querySelector('[data-local-setup-blocker]').textContent, expected)
    assert.deepEqual(actionNames(root), ['check', 'close'])
    popup.close()
  }
})

test('no desktop bridge: the popup says where it works', t => {
  const { root } = mount(t, null)
  assert.equal(view(root), 'absent')
  assert.ok(root.textContent.includes(COPY.noBridge))
})

/* =================================================== keyboard and lifetime */

test('Escape closes it, the keyboard goes back where it was, and progress stops being listened to', async t => {
  const bridge = fakeBridge(statusOf())
  const { root, popup, closes, opener, dom } = mount(t, bridge)
  await popup.ready
  assert.equal(bridge.listeners.size, 1)
  root.dispatch('cancel')
  assert.equal(popup.isClosed(), true)
  assert.equal(root.isConnected, false)
  assert.equal(dom.document.activeElement, opener)
  assert.deepEqual(closes, [{ ready: false }])
  assert.equal(bridge.listeners.size, 0)
})

test('one popup at a time: a second open brings the first forward and hears how it ends', async t => {
  const bridge = fakeBridge(statusOf())
  const { popup, dom } = mount(t, bridge)
  await popup.ready
  const ended = openLocalModelSetupUntilClosed({ document: dom.document, host: dom.document.body, bridge })
  assert.equal(dom.document.body.querySelectorAll('[data-local-setup]').length, 1)
  popup.close()
  assert.equal(await ended, false)
})

test('whether setup is needed is asked of the machine, and an unanswered read needs nothing', async () => {
  assert.equal(await localSetupNeeded(fakeBridge(statusOf())), true)
  assert.equal(await localSetupNeeded(fakeBridge(statusOf({ ready: true }))), false)
  assert.equal(await localSetupNeeded({ localSetupStatus: async () => { throw new Error('gone') } }), false)
  assert.equal(await localSetupNeeded(null), false)
})

/* =================================================== the words */

test('every sentence the popup can say passes the plain-language gate', () => {
  const said = []
  const walk = value => {
    if (typeof value === 'string') said.push(value)
    else if (typeof value === 'function') said.push(value.length >= 2 ? value('100 MB', '1.4 GB') : value('http://127.0.0.1:11434'))
    else if (value && typeof value === 'object') Object.values(value).forEach(walk)
  }
  walk(Object.fromEntries(Object.entries(COPY).filter(([key]) => key !== 'machine')))
  said.push(COPY.machine({ ram: '49 GB', gpu: 'NVIDIA GeForce RTX 4070 Laptop GPU', vram: '8.6 GB' }), COPY.machine({ ram: '8 GB' }))
  said.push(COPY.ready('qwen2.5:0.5b-instruct', 'http://127.0.0.1:11434'), COPY.pulling('Qwen 2.5 0.5B Instruct', '10 MB', '398 MB'))
  said.push(setupSentence({ code: 'LOCAL_SETUP_DISK_FULL', needBytes: 5e9, freeBytes: 1e9 }), setupSentence('SOMETHING_ELSE'))
  const findings = said.flatMap(text => findingsInText(text).map(finding => `${finding.rule}: ${text}`))
  assert.deepEqual(findings, [])
  assert.ok(said.length > 60)
})
