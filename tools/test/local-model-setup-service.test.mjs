/* THE MACHINE HALF OF "SET UP LOCAL MODELS", DRIVEN AGAINST FAKES ONLY.
 *
 * shell/local-model-setup.cjs answers what a computer still needs before a
 * Local agent can start and performs the four actions (get Ollama, start it,
 * download a model through it, ask whether a Local agent can start). Every
 * state is driven here without a real Ollama and without the network:
 *
 *   - a fake Ollama HTTP server (node:http, ephemeral loopback ports only --
 *     never 11434, which belongs to whatever Ollama the person runs) serves
 *     /v1/models, /api/version, /api/tags and a scripted /api/pull stream;
 *   - a fake release page answers the three requests the install makes
 *     (latest tag, sha256sum.txt, the asset through a redirect), with a real
 *     zstd tar built in memory, so the checksum and the unpacking are real;
 *   - Linux, Windows and macOS are platform stubs on the same service.
 *
 * The answering and readiness questions go through the ENGINE's own
 * probeRuntime / resolveLocalTarget (named by MC_CANONICAL_ROOT or the staged
 * capability/ payload), because "one source of truth" is the point: a probe
 * written again here would agree with itself. Without an engine those cases
 * skip by name.
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const require_ = createRequire(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const {
  createLocalModelSetup, extractTar, localAddress, parseChecksums, releaseAsset, safeArchivePath, OFFICIAL_RELEASES,
} = require_(path.join(REPO_ROOT, 'shell', 'local-model-setup.cjs'))

const ENGINE = [process.env.MC_CANONICAL_ROOT, path.join(REPO_ROOT, 'capability')]
  .find(dir => dir && existsSync(path.join(dir, 'src', 'lib', 'providers', 'local-node-runtime.js')))
const skipEngine = ENGINE ? false : 'needs the engine: set MC_CANONICAL_ROOT or stage capability/'
const engineRuntime = ENGINE ? require_(path.join(ENGINE, 'src', 'lib', 'providers', 'local-node-runtime.js')) : null
const engineProcess = ENGINE ? require_(path.join(ENGINE, 'src', 'lib', 'agent-engine', 'local-node-process.js')) : null

const GiB = 1024 ** 3
/* The suggestions the popup shows, given here so these cases do not depend on
   which engine commit is staged; sizes are the registry's (2026-09-23). */
const CATALOGUE = Object.freeze([
  { id: 'qwen2.5:0.5b-instruct', label: 'Qwen 2.5 0.5B Instruct', minFreeVramBytes: 1 * GiB, downloadBytes: 397821319 },
  { id: 'qwen2.5:3b-instruct', label: 'Qwen 2.5 3B Instruct', minFreeVramBytes: 3 * GiB, downloadBytes: 1929912432 },
  { id: 'qwen2.5:7b-instruct', label: 'Qwen 2.5 7B Instruct', minFreeVramBytes: 6 * GiB, downloadBytes: 4683087332 },
  { id: 'qwen2.5-coder:7b', label: 'Qwen 2.5 Coder 7B', minFreeVramBytes: 6 * GiB, downloadBytes: 4683087561 },
  { id: 'llama3.1:8b', label: 'Llama 3.1 8B Instruct', minFreeVramBytes: 7 * GiB, downloadBytes: 4920753328 },
])
const runtime = engineRuntime ? { ...engineRuntime, CURATED_MODELS: CATALOGUE } : null

const settle = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, { timeoutMs = 5000, what = 'condition' } = {}) {
  const started = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await settle(10)
  }
}

function tempRoot(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'local-model-setup-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

/* A port nothing listens on: bound, read, released. */
async function closedPort() {
  const server = http.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

/* ------------------------------------------------ the fake Ollama -- */

function fakeOllama({ models = [], sizes = {}, version = '0.34.3', pull = null } = {}) {
  const requests = []
  const pulls = []
  const server = http.createServer((request, response) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      const entry = { method: request.method, url: request.url, body: Buffer.concat(chunks).toString('utf8') }
      requests.push(entry)
      const json = (value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)) }
      /* A real Ollama with nothing pulled answers `"data": null` (v0.34.3). */
      if (request.method === 'GET' && request.url === '/v1/models') return json({ object: 'list', data: models.length ? models.map(id => ({ id, object: 'model' })) : null })
      if (request.method === 'GET' && request.url === '/api/version') return json({ version })
      if (request.method === 'GET' && request.url === '/api/tags') return json({ models: models.map(name => ({ name, size: sizes[name] ?? 1000 })) })
      if (request.method === 'POST' && request.url === '/api/pull') {
        const record = { body: JSON.parse(entry.body || '{}'), closed: false, finished: false }
        pulls.push(record)
        response.on('close', () => { record.closed = true })
        response.writeHead(200, { 'content-type': 'application/x-ndjson' })
        if (typeof pull === 'function') return pull({ response, record, models })
        response.end()
        return undefined
      }
      json({ error: 'not found' }, 404)
    })
  })
  return {
    requests,
    pulls,
    async listen(port = 0) {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
      this.port = server.address().port
      this.url = `http://127.0.0.1:${this.port}`
      return this
    },
    close() {
      server.closeAllConnections?.()
      return new Promise(resolve => server.close(() => resolve()))
    },
  }
}

const line = value => `${JSON.stringify(value)}\n`

/* A standard pull: manifest, two layers in steps, success. */
function pullSucceeds({ response, record, models }) {
  const digest = 'sha256:aaaa'
  const steps = [
    { status: 'pulling manifest' },
    { status: `pulling ${digest.slice(7)}`, digest, total: 1000, completed: 0 },
    { status: `pulling ${digest.slice(7)}`, digest, total: 1000, completed: 500 },
    { status: `pulling ${digest.slice(7)}`, digest, total: 1000, completed: 1000 },
    { status: 'pulling bbbb', digest: 'sha256:bbbb', total: 24, completed: 24 },
    { status: 'verifying sha256 digest' },
    { status: 'writing manifest' },
    { status: 'success' },
  ]
  let index = 0
  const next = () => {
    if (record.closed) return
    if (index < steps.length) { response.write(line(steps[index++])); setTimeout(next, 5); return }
    models.push(record.body.model)
    record.finished = true
    response.end()
  }
  next()
}

/* --------------------------------------------- settings and engine -- */

function engineReadiness(values) {
  return { resolveLocalTarget: () => engineProcess.resolveLocalTarget({ settings: values }) }
}

function service(t, { platform = 'linux', arch = 'x64', values = {}, env = null, extra = {} } = {}) {
  const root = tempRoot(t)
  const pathDir = path.join(root, 'empty-path')
  mkdirSync(pathDir)
  const setup = createLocalModelSetup({
    platform,
    arch,
    env: env || { PATH: pathDir, HOME: path.join(root, 'home') },
    dataDirectory: path.join(root, 'data'),
    localNodeRuntime: runtime,
    localNodeProcess: engineProcess ? engineReadiness(values) : null,
    readSettingsValues: () => values,
    runFile: (command, args, options, callback) => { callback(Object.assign(new Error('absent'), { code: 'ENOENT' })) },
    totalMemory: () => 32 * GiB,
    freeMemory: () => 24 * GiB,
    freeDisk: () => 500 * GiB,
    fetchImpl: async () => { throw new Error('no network in this suite') },
    ...extra,
  })
  t.after(() => setup.stopAll())
  return { setup, root, data: path.join(root, 'data') }
}

/* ============================================================ addresses */

test('the saved address is read the way the engine reads an Ollama endpoint', () => {
  assert.deepEqual(localAddress(''), { url: 'http://127.0.0.1:11434', host: '127.0.0.1', port: 11434, saved: false, usable: true, local: true })
  assert.equal(localAddress('http://localhost:11500/').url, 'http://localhost:11500')
  assert.equal(localAddress('http://localhost:11500').host, '127.0.0.1')
  assert.equal(localAddress('http://192.168.1.5:11434').local, false, 'another computer cannot be installed or started from here')
  for (const bad of ['https://127.0.0.1:11434', 'http://u:p@127.0.0.1:11434', 'http://127.0.0.1:11434/api', 'localhost:11434', 'http://127.0.0.1:11434/?x=1']) {
    assert.equal(localAddress(bad).usable, false, bad)
  }
})

/* ============================================================ the states */

test('not installed and nothing answering: the default address is asked, nothing else is touched', { skip: skipEngine }, async t => {
  const asked = []
  /* The default address is Ollama's own port, which may be the person's
     running Ollama: this case answers it with a refused connection instead of
     letting a test reach it. */
  const refusing = {
    request(options) {
      asked.push(`${options.host}:${options.port}${options.path}`)
      const request = new EventEmitter()
      request.write = () => {}
      request.end = () => process.nextTick(() => request.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })))
      request.destroy = () => {}
      return request
    },
  }
  const { setup } = service(t, { extra: { httpImpl: refusing } })
  const status = await setup.status()
  assert.equal(status.ok, true)
  assert.equal(status.address.url, 'http://127.0.0.1:11434')
  assert.equal(status.address.saved, false)
  assert.equal(status.installed, false)
  assert.equal(status.running, false)
  assert.equal(status.answering, 'no')
  assert.equal(status.ready, false)
  assert.equal(status.installSupported, true)
  assert.equal(status.installKind, 'tar.zst')
  assert.deepEqual(asked, ['127.0.0.1:11434/v1/models'], 'one probe of the saved (default) address and nothing else')
})

test('installed but not running: the app copy, a program on PATH, and each platform\'s usual place are found', { skip: skipEngine }, async t => {
  const port = await closedPort()
  const values = { 'model.endpoint': `http://127.0.0.1:${port}` }
  {
    const { setup, data } = service(t, { values })
    const binary = path.join(data, 'local-models', 'ollama', 'bin', 'ollama')
    mkdirSync(path.dirname(binary), { recursive: true })
    writeFileSync(binary, '#!/bin/sh\n', { mode: 0o755 })
    const status = await setup.status()
    assert.equal(status.installed, true)
    assert.equal(status.appCopy, true)
    assert.equal(status.running, false)
  }
  {
    const root = tempRoot(t)
    const bin = path.join(root, 'bin')
    mkdirSync(bin)
    writeFileSync(path.join(bin, 'ollama'), '#!/bin/sh\n', { mode: 0o755 })
    const { setup } = service(t, { values, env: { PATH: bin, HOME: root } })
    const status = await setup.status()
    assert.equal(status.installed, true)
    assert.equal(status.appCopy, false)
  }
  {
    const root = tempRoot(t)
    const programs = path.join(root, 'LocalAppData', 'Programs', 'Ollama')
    mkdirSync(programs, { recursive: true })
    writeFileSync(path.join(programs, 'ollama.exe'), 'MZ')
    const { setup } = service(t, { platform: 'win32', values, env: { Path: path.join(root, 'nothing'), LOCALAPPDATA: path.join(root, 'LocalAppData'), USERPROFILE: root } })
    const status = await setup.status()
    assert.equal(status.platform, 'win32')
    assert.equal(status.installed, true, 'the per-user installer\'s place is found on Windows')
    assert.equal(status.installKind, 'installer')
  }
})

test('running with no models: the models list is empty and nothing is chosen', { skip: skipEngine }, async t => {
  const ollama = await fakeOllama({ models: [] }).listen()
  t.after(() => ollama.close())
  const { setup } = service(t, { values: { 'model.endpoint': ollama.url } })
  const status = await setup.status()
  assert.equal(status.running, true)
  assert.equal(status.version, '0.34.3')
  assert.deepEqual(status.models, [])
  assert.equal(status.chosen.model, null)
  assert.equal(status.ready, false)
  assert.ok(ollama.requests.some(request => request.url === '/v1/models'), 'the engine\'s own discovery route was asked')
})

test('a freshly installed Ollama (empty list read as malformed by an older engine) still counts as running, and Start sees it', { skip: skipEngine }, async t => {
  /* The first real run (2026-09-23) stopped here: Ollama answered, its empty
     list came back as "data": null, the engine refused that as malformed, and
     Start waited 30 s for an answer it already had. An engine that refuses the
     list stands in for any engine from before da303d38. */
  const refusesEmptyList = { ...runtime, probeRuntime: async () => { throw Object.assign(new Error('invalid catalogue'), { code: 'LOCAL_NODE_RESPONSE_INVALID' }) } }
  const ollama = await fakeOllama({ models: [] }).listen()
  t.after(() => ollama.close())
  const { setup } = service(t, { values: { 'model.endpoint': ollama.url }, extra: { localNodeRuntime: refusesEmptyList } })
  const status = await setup.status()
  assert.equal(status.running, true, 'its version route answered, so it is running')
  assert.deepEqual(status.models, [])
  assert.deepEqual(await setup.start(), { ok: true, running: true, already: true })
  const direct = service(t, { values: { 'model.endpoint': ollama.url } })
  const listed = await direct.setup.status()
  assert.equal(listed.running, true, 'and through this engine the empty list reads as empty')
  assert.equal(ollama.requests.filter(request => request.url === '/v1/models').length >= 1, true)
})

test('a start that fails carries Ollama\'s own last error line, without this app\'s folder paths', { skip: skipEngine }, async t => {
  const port = await closedPort()
  let data = ''
  const spawnServe = () => servingChild({ port, fail: `Error: could not create directory ${path.join(data, 'local-models', 'models')}: permission denied\n` })
  const made = service(t, { values: { 'model.endpoint': `http://127.0.0.1:${port}` }, extra: { spawnServe } })
  data = made.data
  const binary = path.join(data, 'local-models', 'ollama', 'bin', 'ollama')
  mkdirSync(path.dirname(binary), { recursive: true })
  writeFileSync(binary, '#!/bin/sh\n', { mode: 0o755 })
  const answer = await made.setup.start()
  assert.equal(answer.code, 'LOCAL_SETUP_START_FAILED')
  assert.equal(answer.detail, 'Error: could not create directory the ToolsEnabled folder/models: permission denied')
})

test('running with the chosen model saved: ready is the engine\'s own start check', { skip: skipEngine }, async t => {
  const ollama = await fakeOllama({ models: ['qwen2.5:0.5b-instruct', 'qwen3.5:9b'], sizes: { 'qwen3.5:9b': 6594474711 } }).listen()
  t.after(() => ollama.close())
  const values = { 'model.provider': 'Ollama', 'model.endpoint': ollama.url, 'model.local_agent_name': 'qwen2.5:0.5b-instruct' }
  const { setup } = service(t, { values })
  const status = await setup.status()
  assert.equal(status.running, true)
  assert.equal(status.chosen.installed, true)
  assert.equal(status.chosen.saved, true)
  assert.equal(status.ready, true)
  assert.equal(status.readyCode, null)
  assert.equal(status.catalogue.find(entry => entry.id === 'qwen2.5:0.5b-instruct').downloaded, true)
  const held = status.held.find(row => row.id === 'qwen3.5:9b')
  assert.equal(held.sizeBytes, 6594474711, 'a downloaded model outside the list carries its size from /api/tags')

  values['model.local_agent_name'] = 'qwen2.5:7b-instruct'
  const missing = await setup.status()
  assert.equal(missing.ready, false)
  assert.equal(missing.chosen.installed, false)
  /* Since 1.0.50 the engine sends a named model to the runtime exactly as named and
     lets the runtime refuse it (engine tests/agent-engine/local-node-adapter.test.js,
     "an uncatalogued model reaches the runtime and its named refusal is shown without
     rotation"), so the start question no longer refuses a model Ollama does not hold.
     What this screen tells the person is status() above: not installed, not ready.
     What check() must still never do is answer for a different model than the one
     named, or call a running Ollama missing. No shipped screen calls check() today. */
  const asked = await setup.check()
  assert.equal(asked.model, 'qwen2.5:7b-instruct', 'check() names the chosen model exactly and substitutes nothing')
  assert.notEqual(asked.code, 'LOCAL_NODE_RUNTIME_UNAVAILABLE', 'a running Ollama was reported as missing')

  values['model.provider'] = 'Not configured'
  values['model.local_agent_name'] = 'qwen2.5:0.5b-instruct'
  const unsaved = await setup.status()
  assert.equal(unsaved.chosen.installed, true)
  assert.equal(unsaved.chosen.saved, false, 'a model that is here but not saved as Ollama\'s is not ready')
  assert.equal(unsaved.ready, false)
})

/* ============================================================ memory */

test('fit follows the graphics card\'s size; a need close to free memory is marked; the suggestion fits the card', { skip: skipEngine }, async t => {
  const ollama = await fakeOllama({ models: ['qwen3.5:9b'], sizes: { 'qwen3.5:9b': 6594474711 } }).listen()
  t.after(() => ollama.close())
  let freeRam = 24 * GiB
  let freeVramMiB = 7900
  const card = (command, args, options, callback) => {
    assert.match(command, /^nvidia-smi/)
    callback(null, `NVIDIA GeForce RTX 4070 Laptop GPU, 8188, ${freeVramMiB}\n`)
  }
  const { setup } = service(t, { values: { 'model.endpoint': ollama.url }, extra: { runFile: card, totalMemory: () => 46 * GiB, freeMemory: () => freeRam, now: (() => { let at = 0; return () => (at += 20_000) })() } })
  const roomy = await setup.status()
  assert.equal(roomy.hardware.gpuName, 'NVIDIA GeForce RTX 4070 Laptop GPU')
  assert.equal(roomy.hardware.vramBytes, 8188 * 1024 * 1024)
  assert.deepEqual(Object.fromEntries(roomy.catalogue.map(entry => [entry.id, entry.fit])), {
    'qwen2.5:0.5b-instruct': 'gpu', 'qwen2.5:3b-instruct': 'gpu', 'qwen2.5:7b-instruct': 'gpu', 'qwen2.5-coder:7b': 'gpu', 'llama3.1:8b': 'gpu',
  })
  assert.equal(roomy.catalogue.some(entry => entry.tight), false)
  assert.equal(roomy.recommended, 'qwen2.5:7b-instruct',
    'the largest model that fits the card with a sixth of it to spare is suggested (the general one of two the same size); the 8B would leave the screen too little')

  freeRam = 1 * GiB
  freeVramMiB = 1000
  const busy = await setup.status()
  assert.deepEqual(busy.catalogue.filter(entry => entry.tight).map(entry => entry.id), ['qwen2.5:3b-instruct', 'qwen2.5:7b-instruct', 'qwen2.5-coder:7b', 'llama3.1:8b'],
    'a need above four fifths of free system plus graphics memory is marked')
  assert.equal(busy.recommended, 'qwen2.5:0.5b-instruct', 'with little free, the suggestion is the largest card fit that is not tight')
  assert.equal(busy.held.find(row => row.id === 'qwen3.5:9b').tight, true, 'a 9B model on a busy computer is marked too')
})

test('with no graphics card to read, models run on the processor or are too large', { skip: skipEngine }, async t => {
  const port = await closedPort()
  const { setup } = service(t, { values: { 'model.endpoint': `http://127.0.0.1:${port}` }, extra: { totalMemory: () => 8 * GiB, freeMemory: () => 6 * GiB } })
  const status = await setup.status()
  assert.equal(status.hardware.vramBytes, null)
  assert.deepEqual(Object.fromEntries(status.catalogue.map(entry => [entry.id, entry.fit])), {
    'qwen2.5:0.5b-instruct': 'cpu', 'qwen2.5:3b-instruct': 'cpu', 'qwen2.5:7b-instruct': 'too-big', 'qwen2.5-coder:7b': 'too-big', 'llama3.1:8b': 'too-big',
  })
  assert.equal(status.recommended, 'qwen2.5:0.5b-instruct', 'with no card, the smallest model that runs is suggested')
})

/* ============================================================ the pull */

async function collectPull(setup, model, extra = {}) {
  const events = []
  const answer = await setup.pull({ model, ...extra }, packet => events.push(packet))
  return { answer, events }
}

test('a pull goes through Ollama with streamed progress, then the model is there', { skip: skipEngine }, async t => {
  const ollama = await fakeOllama({ models: [], pull: pullSucceeds }).listen()
  t.after(() => ollama.close())
  const values = { 'model.endpoint': ollama.url }
  const { setup } = service(t, { values })
  const { answer, events } = await collectPull(setup, 'qwen2.5:0.5b-instruct')
  assert.equal(answer.ok, true)
  assert.equal(answer.diskChecked, true, 'free space was checked against the listed size first')
  const last = await until(() => events.find(event => event.phase === 'done'), { what: 'the pull to finish' })
  assert.equal(last.kind, 'pull')
  assert.equal(last.model, 'qwen2.5:0.5b-instruct')
  assert.equal(last.completed, 1024)
  assert.equal(last.total, 1024)
  assert.deepEqual(ollama.pulls[0].body, { model: 'qwen2.5:0.5b-instruct', stream: true })
  const status = await setup.status()
  assert.equal(status.catalogue.find(entry => entry.id === 'qwen2.5:0.5b-instruct').downloaded, true)
  assert.equal(status.activity.pull.phase, 'done')
  assert.equal(status.activity.pull.running, false)
})

test('a pull Ollama refuses reports its own words and a plain code', { skip: skipEngine }, async t => {
  const ollama = await fakeOllama({
    pull: ({ response }) => { response.write(line({ status: 'pulling manifest' })); response.end(line({ error: 'pull model manifest: file does not exist' })) },
  }).listen()
  t.after(() => ollama.close())
  const { setup } = service(t, { values: { 'model.endpoint': ollama.url } })
  const { events } = await collectPull(setup, 'no-such-model:1b')
  const failed = await until(() => events.find(event => event.phase === 'failed'))
  assert.equal(failed.code, 'LOCAL_SETUP_PULL_UNKNOWN_MODEL')
  assert.equal(failed.detail, 'pull model manifest: file does not exist')
})

test('disk full: refused before the pull when the listed size does not fit, and named when Ollama runs out mid-way', { skip: skipEngine }, async t => {
  const ollama = await fakeOllama({
    pull: ({ response }) => {
      response.write(line({ status: 'pulling aaaa', digest: 'sha256:aaaa', total: 1000, completed: 400 }))
      response.end(line({ error: 'write /models/blobs/sha256-aaaa-partial: no space left on device' }))
    },
  }).listen()
  t.after(() => ollama.close())
  {
    const { setup } = service(t, { values: { 'model.endpoint': ollama.url }, extra: { freeDisk: () => 100 * 1024 ** 2 } })
    const { answer, events } = await collectPull(setup, 'qwen2.5:0.5b-instruct')
    assert.equal(answer.ok, false)
    assert.equal(answer.code, 'LOCAL_SETUP_DISK_FULL')
    assert.equal(answer.freeBytes, 100 * 1024 ** 2)
    assert.ok(answer.needBytes > 397821319)
    assert.equal(events.length, 0)
    assert.equal(ollama.pulls.length, 0, 'nothing was asked of Ollama')
  }
  {
    const { setup } = service(t, { values: { 'model.endpoint': ollama.url } })
    const { events } = await collectPull(setup, 'qwen2.5:0.5b-instruct')
    const failed = await until(() => events.find(event => event.phase === 'failed'))
    assert.equal(failed.code, 'LOCAL_SETUP_PULL_DISK_FULL')
  }
})

test('cancel ends the pull: the request to Ollama is closed and the popup is told', { skip: skipEngine }, async t => {
  const ollama = await fakeOllama({
    pull: ({ response }) => { response.write(line({ status: 'pulling aaaa', digest: 'sha256:aaaa', total: 1000, completed: 10 })) },
  }).listen()
  t.after(() => ollama.close())
  const { setup } = service(t, { values: { 'model.endpoint': ollama.url } })
  const { events } = await collectPull(setup, 'qwen2.5:3b-instruct')
  await until(() => events.find(event => event.phase === 'progress' && event.completed === 10), { what: 'first progress' })
  assert.deepEqual(setup.cancelPull(), { ok: true, cancelled: true })
  const cancelled = await until(() => events.find(event => event.phase === 'cancelled'))
  assert.equal(cancelled.code, 'LOCAL_SETUP_CANCELLED')
  await until(() => ollama.pulls[0].closed, { what: 'Ollama to see the request close' })
  assert.equal(ollama.pulls[0].finished, false)
  assert.deepEqual(setup.cancelPull(), { ok: true, cancelled: false }, 'a second cancel has nothing to stop')
})

test('a pull is refused when nothing answers, and for a name no model can have', { skip: skipEngine }, async t => {
  const port = await closedPort()
  const { setup } = service(t, { values: { 'model.endpoint': `http://127.0.0.1:${port}` } })
  assert.equal((await setup.pull({ model: 'qwen2.5:3b-instruct' })).code, 'LOCAL_SETUP_NOT_RUNNING')
  assert.equal((await setup.pull({ model: '../../etc' })).code, 'LOCAL_SETUP_MODEL_INVALID')
  assert.equal((await setup.pull({ model: 'a b' })).code, 'LOCAL_SETUP_MODEL_INVALID')
})

/* ============================================================ the install */

function tarEntry({ name, type = '0', mode = 0o644, body = Buffer.alloc(0), linkname = '' }) {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 8, 'latin1')
  header.write('0000000\0', 108, 8, 'latin1')
  header.write('0000000\0', 116, 8, 'latin1')
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'latin1')
  header.write('00000000000\0', 136, 12, 'latin1')
  header.fill(0x20, 148, 156)
  header.write(type, 156, 1, 'latin1')
  header.write(linkname, 157, 100, 'utf8')
  header.write('ustar\0', 257, 6, 'latin1')
  header.write('00', 263, 2, 'latin1')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1')
  return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)])
}
const tarball = entries => Buffer.concat([...entries.map(tarEntry), Buffer.alloc(1024)])
const OLLAMA_TREE = [
  { name: 'bin/', type: '5', mode: 0o755 },
  { name: 'bin/ollama', mode: 0o755, body: Buffer.from('#!/bin/sh\necho ollama\n') },
  { name: 'lib/ollama/', type: '5', mode: 0o755 },
  { name: 'lib/ollama/libggml-base.so', body: Buffer.alloc(3000, 7) },
  { name: 'lib/ollama/libggml-base.so.0', type: '2', linkname: 'libggml-base.so' },
]
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex')

/* The release page, faked at the fetch boundary: latest → tag, checksums,
   and the asset through the redirect GitHub really answers with. */
function fakeReleases({ assets, sums = null, tag = 'v0.34.3', redirect = 'https://release-assets.githubusercontent.com/github-production-release-asset/', stall = false } = {}) {
  const calls = []
  const text = sums ?? Object.entries(assets).map(([name, body]) => `${sha256(body)}  ./${name}`).join('\n')
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, redirect: options.redirect })
    if (url === OFFICIAL_RELEASES.latest) return new Response(null, { status: 302, headers: { location: `https://github.com/ollama/ollama/releases/tag/${tag}` } })
    const base = OFFICIAL_RELEASES.download(tag)
    if (url === `${base}sha256sum.txt`) return new Response(text)
    if (url.startsWith(base)) return new Response(null, { status: 302, headers: { location: `${redirect}${url.slice(base.length)}` } })
    if (url.startsWith(redirect)) {
      const body = assets[url.slice(redirect.length)]
      if (!body) return new Response('missing', { status: 404 })
      const stream = new ReadableStream({
        start(controller) {
          if (stall) { controller.enqueue(new Uint8Array(body.subarray(0, 100))); return }
          controller.enqueue(new Uint8Array(body)); controller.close()
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-length': String(body.length) } })
    }
    return new Response('not found', { status: 404 })
  }
  return { fetchImpl, calls }
}

async function install(setup) {
  const events = []
  const answer = setup.install(packet => events.push(packet))
  const last = answer.ok ? await until(() => events.find(event => ['done', 'ready', 'failed', 'cancelled'].includes(event.phase)), { timeoutMs: 10000, what: 'the install to end' }) : null
  return { answer, events, last }
}

test('Linux: Ollama comes from the official release, is checked against its published SHA-256, and unpacks into the app folder', { skip: skipEngine }, async t => {
  const archive = zlib.zstdCompressSync(tarball(OLLAMA_TREE))
  const releases = fakeReleases({ assets: { 'ollama-linux-amd64.tar.zst': archive, 'OllamaSetup.exe': Buffer.from('other') } })
  const port = await closedPort()
  const { setup, data, root } = service(t, { values: { 'model.endpoint': `http://127.0.0.1:${port}` }, extra: { fetchImpl: releases.fetchImpl } })
  const { answer, events, last } = await install(setup)
  assert.deepEqual(answer, { ok: true, started: true, asset: 'ollama-linux-amd64.tar.zst' })
  assert.equal(last.phase, 'done', JSON.stringify(events.at(-1)))
  assert.equal(last.version, 'v0.34.3')
  const phases = [...new Set(events.map(event => event.phase))]
  assert.deepEqual(phases, ['release', 'download', 'verify', 'unpack', 'done'])
  assert.ok(releases.calls.every(call => call.redirect === 'manual' && call.url.startsWith('https://')), 'every hop is https and followed by this code, not by fetch')
  const home = path.join(data, 'local-models', 'ollama')
  assert.equal(readFileSync(path.join(home, 'bin', 'ollama'), 'utf8'), '#!/bin/sh\necho ollama\n')
  assert.equal(statSync(path.join(home, 'bin', 'ollama')).mode & 0o111, 0o111, 'the program is executable')
  assert.equal(readlinkSync(path.join(home, 'lib', 'ollama', 'libggml-base.so.0')), 'libggml-base.so')
  assert.deepEqual(readdirSync(path.join(data, 'local-models', 'downloads')), [], 'the archive is not kept after unpacking')
  assert.equal(JSON.parse(readFileSync(path.join(data, 'local-models', 'install.json'), 'utf8')).sha256, sha256(archive))
  const status = await setup.status()
  assert.equal(status.installed, true)
  assert.equal(status.appCopy, true)
  assert.equal(JSON.stringify([status, events]).includes(root), false, 'no path on this computer reaches the window')
})

test('a download that does not match the published checksum is deleted and nothing is installed', { skip: skipEngine }, async t => {
  const archive = zlib.zstdCompressSync(tarball(OLLAMA_TREE))
  const releases = fakeReleases({ assets: { 'ollama-linux-amd64.tar.zst': archive }, sums: `${'0'.repeat(64)}  ./ollama-linux-amd64.tar.zst\n` })
  const { setup, data } = service(t, { extra: { fetchImpl: releases.fetchImpl } })
  const { last } = await install(setup)
  assert.equal(last.phase, 'failed')
  assert.equal(last.code, 'LOCAL_SETUP_CHECKSUM_MISMATCH')
  assert.equal(existsSync(path.join(data, 'local-models', 'ollama')), false)
  assert.deepEqual(readdirSync(path.join(data, 'local-models', 'downloads')), [])
})

test('no published checksum, a host other than the release page, or plain http: refused before anything is kept', { skip: skipEngine }, async t => {
  const archive = zlib.zstdCompressSync(tarball(OLLAMA_TREE))
  {
    const releases = fakeReleases({ assets: { 'ollama-linux-amd64.tar.zst': archive }, sums: `${sha256(archive)}  ./something-else.tar.zst\n` })
    const { setup } = service(t, { extra: { fetchImpl: releases.fetchImpl } })
    assert.equal((await install(setup)).last.code, 'LOCAL_SETUP_CHECKSUM_UNPUBLISHED')
  }
  for (const redirect of ['https://downloads.example.com/', 'http://release-assets.githubusercontent.com/']) {
    const releases = fakeReleases({ assets: { 'ollama-linux-amd64.tar.zst': archive }, redirect })
    const { setup, data } = service(t, { extra: { fetchImpl: releases.fetchImpl } })
    const { last } = await install(setup)
    assert.equal(last.code, 'LOCAL_SETUP_SOURCE_REFUSED', redirect)
    assert.equal(releases.calls.some(call => call.url.startsWith(redirect)), false, `${redirect} was never fetched`)
    assert.equal(existsSync(path.join(data, 'local-models', 'ollama')), false)
  }
})

test('an archive entry that would land outside the folder refuses the whole archive', async t => {
  for (const [label, entries] of [
    ['parent path', [{ name: '../evil', body: Buffer.from('x') }]],
    ['absolute path', [{ name: '/tmp/evil', body: Buffer.from('x') }]],
    ['link out', [{ name: 'lib/', type: '5' }, { name: 'lib/out', type: '2', linkname: '../../outside' }]],
    ['file through a link', [{ name: 'lib', type: '2', linkname: '.' }, { name: 'lib/x', type: '2', linkname: '../..' }, { name: 'lib/x/evil', body: Buffer.from('x') }]],
    ['device', [{ name: 'dev', type: '3' }]],
  ]) {
    const root = tempRoot(t)
    const destination = path.join(root, 'into')
    mkdirSync(destination)
    const chunks = (async function * () { yield tarball(entries) })()
    await assert.rejects(extractTar(chunks, destination), error => error.code === 'LOCAL_SETUP_ARCHIVE_INVALID', label)
    assert.equal(existsSync(path.join(root, 'evil')), false, label)
    assert.equal(existsSync(path.join(root, 'outside')), false, label)
  }
  assert.equal(safeArchivePath('./bin/ollama'), 'bin/ollama')
  assert.equal(safeArchivePath('bin\\ollama'), null)
})

test('an unpacked archive is refused when it carries no program', { skip: skipEngine }, async t => {
  const archive = zlib.zstdCompressSync(tarball([{ name: 'README', body: Buffer.from('no program here') }]))
  const releases = fakeReleases({ assets: { 'ollama-linux-amd64.tar.zst': archive } })
  const { setup, data } = service(t, { extra: { fetchImpl: releases.fetchImpl } })
  const { last } = await install(setup)
  assert.equal(last.code, 'LOCAL_SETUP_ARCHIVE_INVALID')
  assert.equal(existsSync(path.join(data, 'local-models', 'ollama')), false)
  assert.deepEqual(readdirSync(path.join(data, 'local-models')).filter(name => name.includes('partial')), [], 'the staging folder is removed')
})

test('install disk check: refused before writing when the download and its unpacked copy do not fit', { skip: skipEngine }, async t => {
  const archive = zlib.zstdCompressSync(tarball(OLLAMA_TREE))
  const releases = fakeReleases({ assets: { 'ollama-linux-amd64.tar.zst': archive } })
  const { setup, data } = service(t, { extra: { fetchImpl: releases.fetchImpl, freeDisk: () => 1024 } })
  const { last } = await install(setup)
  assert.equal(last.code, 'LOCAL_SETUP_DISK_FULL')
  assert.equal(last.freeBytes, 1024)
  assert.ok(last.needBytes > archive.length)
  assert.deepEqual(readdirSync(path.join(data, 'local-models', 'downloads')), [])
})

test('cancel stops a download that has gone quiet, and the partial file is removed', { skip: skipEngine }, async t => {
  const archive = zlib.zstdCompressSync(tarball(OLLAMA_TREE))
  const releases = fakeReleases({ assets: { 'ollama-linux-amd64.tar.zst': archive }, stall: true })
  const { setup, data } = service(t, { extra: { fetchImpl: releases.fetchImpl } })
  const events = []
  assert.equal(setup.install(packet => events.push(packet)).ok, true)
  await until(() => events.find(event => event.phase === 'download'), { what: 'the download to begin' })
  assert.equal(setup.install().code, 'LOCAL_SETUP_BUSY', 'one install at a time')
  assert.deepEqual(setup.cancelInstall(), { ok: true, cancelled: true })
  const last = await until(() => events.find(event => event.phase === 'cancelled'))
  assert.equal(last.code, 'LOCAL_SETUP_CANCELLED')
  assert.deepEqual(readdirSync(path.join(data, 'local-models', 'downloads')), [])
})

test('Windows: the checked per-user installer runs only on the person\'s press, and is checked again first', { skip: skipEngine }, async t => {
  const installer = Buffer.from('MZ fake per-user installer')
  const releases = fakeReleases({ assets: { 'OllamaSetup.exe': installer } })
  const started = []
  const spawnInstaller = (command, args, options) => {
    started.push({ command, args, options })
    const child = new EventEmitter()
    setTimeout(() => child.emit('exit', 0), 5)
    return child
  }
  const root = tempRoot(t)
  const { setup, data } = service(t, { platform: 'win32', env: { Path: root, LOCALAPPDATA: path.join(root, 'LocalAppData'), USERPROFILE: root }, extra: { fetchImpl: releases.fetchImpl, spawnInstaller } })
  const { answer, last } = await install(setup)
  assert.equal(answer.asset, 'OllamaSetup.exe')
  assert.equal(last.phase, 'ready')
  assert.deepEqual(started, [], 'downloading and checking starts nothing')
  const waiting = await setup.status()
  assert.equal(waiting.installerReady, true)
  assert.equal(waiting.installed, false)

  const file = path.join(data, 'local-models', 'downloads', 'OllamaSetup.exe')
  writeFileSync(file, Buffer.from('MZ something else'))
  assert.equal((await setup.runInstaller()).code, 'LOCAL_SETUP_CHECKSUM_MISMATCH', 'a changed file is refused, not run')
  assert.equal(existsSync(file), false)
  assert.deepEqual(started, [])

  await install(setup)
  const events = []
  assert.deepEqual(await setup.runInstaller(packet => events.push(packet)), { ok: true, started: true })
  assert.equal(started.length, 1)
  assert.equal(started[0].command, file)
  assert.deepEqual(started[0].args, [])
  assert.equal(started[0].options.detached, true)
  assert.equal(started[0].options.windowsHide, false, 'the installer\'s own window is shown to the person')
  await until(() => events.find(event => event.kind === 'installer' && event.phase === 'done'))
  assert.equal(existsSync(file), false, 'the installer is removed once it has finished')
})

test('macOS: the official app zip is checked, then unpacked with the system unzipper into the app folder', { skip: skipEngine }, async t => {
  const zip = Buffer.from('PK fake app zip')
  const releases = fakeReleases({ assets: { 'Ollama-darwin.zip': zip } })
  const unzips = []
  const spawnInstaller = (command, args) => {
    unzips.push({ command, args })
    const binary = path.join(args[3], 'Ollama.app', 'Contents', 'Resources', 'ollama')
    mkdirSync(path.dirname(binary), { recursive: true })
    writeFileSync(binary, '#!/bin/sh\n', { mode: 0o755 })
    const child = new EventEmitter()
    setTimeout(() => child.emit('exit', 0), 1)
    return child
  }
  const { setup, data } = service(t, { platform: 'darwin', arch: 'arm64', extra: { fetchImpl: releases.fetchImpl, spawnInstaller } })
  const { last } = await install(setup)
  assert.equal(last.phase, 'done')
  assert.equal(unzips[0].command, '/usr/bin/ditto')
  assert.deepEqual(unzips[0].args.slice(0, 2), ['-x', '-k'])
  assert.equal(existsSync(path.join(data, 'local-models', 'app', 'Ollama.app', 'Contents', 'Resources', 'ollama')), true)
  assert.equal((await setup.status()).appCopy, true)
})

test('the asset for each computer, and none for one Ollama does not build for', () => {
  assert.equal(releaseAsset('linux', 'x64').name, 'ollama-linux-amd64.tar.zst')
  assert.equal(releaseAsset('linux', 'arm64').name, 'ollama-linux-arm64.tar.zst')
  assert.equal(releaseAsset('win32', 'x64').name, 'OllamaSetup.exe')
  assert.equal(releaseAsset('darwin', 'x64').name, 'Ollama-darwin.zip')
  assert.equal(releaseAsset('linux', 'ia32'), null)
  assert.equal(releaseAsset('freebsd', 'x64'), null)
  const sums = parseChecksums(`${'a'.repeat(64)}  ./OllamaSetup.exe\n${'b'.repeat(64)}  ./ollama-linux-amd64.tar.zst\n`)
  assert.equal(sums.get('OllamaSetup.exe'), 'a'.repeat(64))
  assert.equal(parseChecksums(`${'a'.repeat(64)}  ./x\n${'b'.repeat(64)}  ./x\n`), null, 'two different sums for one file are refused')
})

/* ============================================================ serving */

function servingChild({ port, fail = null }) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  let ollama = null
  const exit = code => { if (!child.exited) { child.exited = true; child.emit('exit', code) } }
  if (fail) {
    setTimeout(() => { child.stderr.emit('data', Buffer.from(fail)); exit(1) }, 5)
  } else {
    ollama = fakeOllama({ models: [] })
    setTimeout(() => { void ollama.listen(port) }, 20)
  }
  child.terminateJob = async () => { await ollama?.close(); exit(null) }
  child.kill = () => { void ollama?.close(); exit(null); return true }
  return child
}

test('start: this app\'s copy serves on the saved address, keeps its models and home in the app folder, and stops cleanly', { skip: skipEngine }, async t => {
  const port = await closedPort()
  const spawned = []
  const spawnServe = (command, args, options) => { spawned.push({ command, args, options }); return servingChild({ port }) }
  const { setup, data } = service(t, { values: { 'model.endpoint': `http://127.0.0.1:${port}` }, extra: { spawnServe } })
  assert.equal((await setup.start()).code, 'LOCAL_SETUP_NOT_INSTALLED')
  const binary = path.join(data, 'local-models', 'ollama', 'bin', 'ollama')
  mkdirSync(path.dirname(binary), { recursive: true })
  writeFileSync(binary, '#!/bin/sh\n', { mode: 0o755 })
  const started = await setup.start()
  assert.deepEqual(started, { ok: true, running: true, startedHere: true, address: `http://127.0.0.1:${port}` })
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].command, binary)
  assert.deepEqual(spawned[0].args, ['serve'])
  assert.equal(spawned[0].options.containProcessTree, true, 'its runners are one tracked tree')
  assert.equal(spawned[0].options.env.OLLAMA_HOST, `127.0.0.1:${port}`)
  assert.equal(spawned[0].options.env.OLLAMA_MODELS, path.join(data, 'local-models', 'models'))
  assert.equal(spawned[0].options.env.HOME, path.join(data, 'local-models', 'home'), 'the key file Ollama writes stays in the app folder')
  const running = await setup.status()
  assert.equal(running.running, true)
  assert.equal(running.startedHere, true)
  assert.deepEqual(await setup.start(), { ok: true, running: true, already: true })
  assert.deepEqual(await setup.stop(), { ok: true, stopped: true })
  await until(async () => !(await setup.status()).running, { what: 'Ollama to stop answering' })
  assert.deepEqual(await setup.stop(), { ok: true, stopped: false })
})

test('start on Windows uses the person\'s own install as it is, with only the address set', { skip: skipEngine }, async t => {
  const port = await closedPort()
  const root = tempRoot(t)
  const programs = path.join(root, 'LocalAppData', 'Programs', 'Ollama')
  mkdirSync(programs, { recursive: true })
  writeFileSync(path.join(programs, 'ollama.exe'), 'MZ')
  const spawned = []
  const spawnServe = (command, args, options) => { spawned.push({ command, args, options }); return servingChild({ port }) }
  const env = { Path: path.join(root, 'none'), LOCALAPPDATA: path.join(root, 'LocalAppData'), USERPROFILE: root }
  const { setup } = service(t, { platform: 'win32', env, values: { 'model.endpoint': `http://127.0.0.1:${port}` }, extra: { spawnServe } })
  assert.equal((await setup.start()).ok, true)
  assert.equal(spawned[0].command, path.join(programs, 'ollama.exe'))
  assert.equal(spawned[0].options.env.OLLAMA_HOST, `127.0.0.1:${port}`)
  assert.equal(spawned[0].options.env.OLLAMA_MODELS, undefined, 'a person\'s own install keeps its own models folder')
  assert.equal(spawned[0].options.env.USERPROFILE, root)
})

test('start refuses what it cannot do: another computer, an address in use, and a foreign Ollama in isolated test mode', { skip: skipEngine }, async t => {
  {
    const { setup } = service(t, { values: { 'model.endpoint': 'http://192.168.9.9:11434' } })
    assert.equal((await setup.start()).code, 'LOCAL_SETUP_ADDRESS_REMOTE')
  }
  const port = await closedPort()
  {
    const spawnServe = () => servingChild({ port, fail: `Error: listen tcp 127.0.0.1:${port}: bind: address already in use\n` })
    const { setup, data } = service(t, { values: { 'model.endpoint': `http://127.0.0.1:${port}` }, extra: { spawnServe } })
    const binary = path.join(data, 'local-models', 'ollama', 'bin', 'ollama')
    mkdirSync(path.dirname(binary), { recursive: true })
    writeFileSync(binary, '#!/bin/sh\n', { mode: 0o755 })
    assert.equal((await setup.start()).code, 'LOCAL_SETUP_PORT_IN_USE')
  }
  {
    const root = tempRoot(t)
    const bin = path.join(root, 'bin')
    mkdirSync(bin)
    writeFileSync(path.join(bin, 'ollama'), '#!/bin/sh\n', { mode: 0o755 })
    chmodSync(path.join(bin, 'ollama'), 0o755)
    const { setup } = service(t, { env: { PATH: bin, HOME: root }, values: { 'model.endpoint': `http://127.0.0.1:${port}` }, extra: { isolated: true, spawnServe: () => assert.fail('nothing may start') } })
    assert.equal((await setup.start()).code, 'LOCAL_SETUP_ISOLATED')
  }
})

test('in isolated test mode a pull goes only to the Ollama this app started', { skip: skipEngine }, async t => {
  const ollama = await fakeOllama({ pull: pullSucceeds }).listen()
  t.after(() => ollama.close())
  const { setup } = service(t, { values: { 'model.endpoint': ollama.url }, extra: { isolated: true } })
  assert.equal((await setup.pull({ model: 'qwen2.5:0.5b-instruct' })).code, 'LOCAL_SETUP_ISOLATED')
  assert.equal(ollama.pulls.length, 0)
})
