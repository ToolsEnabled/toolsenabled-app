// T1701: disk errors in "Set up local models" (shell/local-model-setup.cjs).
//
// The real service and archive reader, with every file, network and process
// dependency replaced by an in-memory stand-in; nothing is downloaded,
// started or written. Each finding has a healthy control beside it:
//   - a log write that fails after start() is taken by the service (not
//     thrown in the main process) and status() keeps the reason;
//   - a download write that fails while the connection is silent ends the
//     install at once as failed, with the disk's reason, and publishes
//     nothing;
//   - an archive file handle that takes fewer bytes than it was given still
//     ends up with every byte of the program.
// The Writable stand-in catches an otherwise escaping 'error' event only to
// assert on it; it installs no listener of its own.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { Writable } from 'node:stream'
import { setImmediate as turn } from 'node:timers/promises'
import path from 'node:path'
import test from 'node:test'
import setupModule from '../../shell/local-model-setup.cjs'

const { createLocalModelSetup, extractTar } = setupModule
const GiB = 1024 ** 3
const diskError = code => Object.assign(new Error(`inert ${code} write refusal`), { code })
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const forbidden = name => () => { throw new Error(`Unexpected real dependency: ${name}`) }

class InertWritable extends Writable {
  constructor({ hold = false } = {}) {
    super()
    this.hold = hold
    this.started = deferred()
    this.errorSeen = deferred()
    this.parts = []
    this.escaped = null
    this.errorEvents = 0
  }
  _write(chunk, _encoding, done) {
    this.parts.push(Buffer.from(chunk))
    this.pendingWrite = done
    this.started.resolve()
    if (!this.hold) done()
  }
  emit(event, ...args) {
    if (event !== 'error') return super.emit(event, ...args)
    this.errorEvents += 1
    // Do not install an error listener: retain an otherwise escaping error
    // as an assertion without crashing unrelated cases in this one suite.
    try { return super.emit(event, ...args) }
    catch (error) { this.escaped = error; return false }
    finally { this.errorSeen.resolve() }
  }
}

function serviceOptions(extra = {}) {
  return {
    platform: 'linux', arch: 'x64', env: {},
    dataDirectory: path.resolve('inert-t1701-data'),
    fsApi: { async mkdir() {}, async rm() {} },
    fsSync: { statSync: () => ({ isFile: () => true }), createWriteStream: forbidden('write stream') },
    freeDisk: () => 64 * GiB,
    totalMemory: () => 16 * GiB, freeMemory: () => 12 * GiB,
    runFile: (_file, _args, _options, callback) => callback(diskError('ENOENT')),
    readSettingsValues: () => ({}),
    localNodeProcess: { async resolveLocalTarget() { return {} } },
    fetchImpl: forbidden('fetch'), httpImpl: { request: forbidden('http') },
    spawnInstaller: forbidden('installer'),
    ...extra,
  }
}

async function startLogCase(t, errorCode) {
  const log = new InertWritable({ hold: Boolean(errorCode) })
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  let childExited = false
  child.kill = () => { childExited = true; child.emit('exit', 0); return true }
  let probes = 0
  const service = createLocalModelSetup(serviceOptions({
    fsSync: { statSync: () => ({ isFile: () => true }), createWriteStream: () => log },
    spawnServe: () => child,
    localNodeRuntime: {
      async probeRuntime() { return { listening: ++probes > 1 && !childExited, models: [] } },
      async readRuntimeVersion() { return 'inert' },
    },
  }))
  try {
    const started = await service.start()
    assert.equal(started.ok, true, 'actual start must succeed before injection')
    child.stdout.emit('data', Buffer.from('inert startup line'))
    await log.started.promise
    if (!errorCode) {
      assert.equal((await service.status()).startedHere, true)
      assert.equal(Buffer.concat(log.parts).toString(), 'inert startup line')
      assert.equal(log.escaped, null)
      return
    }
    log.pendingWrite(diskError(errorCode))
    await log.errorSeen.promise
    await turn()
    const status = await service.status()
    t.diagnostic(JSON.stringify({ case: 'start log', injected: errorCode, errorEvents: log.errorEvents,
      escaped: log.escaped?.code ?? null, startedHere: status.startedHere, activity: status.activity }))
    assert.equal(log.escaped?.code ?? null, null, 'the owned log error must be consumed by the service')
    assert.match(JSON.stringify(status), /LOCAL_SETUP_[A-Z_]*(?:FAILED|DISK|LOG|WRITE|STORAGE)[A-Z_]*/,
      'status must retain the log failure for a later popup read')
  } finally {
    service.stopAll()
    log.destroy()
    await turn()
    assert.equal(childExited, true, 'the inert child was retired')
  }
}

test('control: successful start writes only to an inert log and retires the child', t => startLogCase(t, null))
test('start: asynchronous ENOSPC log failure is consumed and retained visibly', t => startLogCase(t, 'ENOSPC'))

async function downloadCase(t, errorCode) {
  const payload = Buffer.from('inert verified download')
  const hash = createHash('sha256').update(payload).digest('hex')
  const asset = 'OllamaSetup.exe'
  const out = new InertWritable({ hold: Boolean(errorCode) })
  let cancelled = false
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(payload)
      if (!errorCode) controller.close()
    },
    cancel() { cancelled = true },
  })
  let fetches = 0
  const events = []
  const mutations = []
  const service = createLocalModelSetup(serviceOptions({
    platform: 'win32',
    fsSync: { statSync: () => ({ isFile: () => true }), createWriteStream: () => out },
    fsApi: {
      async mkdir() {},
      async rm() { mutations.push('inert cleanup') },
      async rename() { mutations.push('inert publish') },
    },
    localNodeRuntime: { async probeRuntime() { return { listening: false, models: [] } } },
    fetchImpl: async url => {
      fetches += 1
      if (url.endsWith('/latest')) return new Response(null, { status: 302, headers: { location: 'https://github.com/ollama/ollama/releases/tag/v1.2.3' } })
      if (url.endsWith('/sha256sum.txt')) return new Response(`${hash}  ${asset}\n`)
      assert.equal(url.endsWith(`/${asset}`), true, 'only the release asset is requested')
      return new Response(body, { headers: { 'content-length': String(payload.length) } })
    },
  }))
  try {
    assert.equal(service.install(event => events.push(event)).ok, true)
    await out.started.promise
    assert.equal(fetches, 3, 'inert release, checksum and body paths reached')
    if (!errorCode) {
      await service.settled()
      const status = await service.status()
      assert.equal(status.activity.install.phase, 'ready')
      assert.equal(status.activity.install.running, false)
      assert.deepEqual(Buffer.concat(out.parts), payload)
      assert.equal(events.at(-1).phase, 'ready')
      assert.equal(out.escaped, null)
      return
    }
    // write() accepted the chunk without drain/backpressure. The network is
    // deliberately silent when the real Writable reports its disk error.
    out.pendingWrite(diskError(errorCode))
    await out.errorSeen.promise
    for (let i = 0; i < 3; i += 1) await turn()
    const status = await service.status()
    t.diagnostic(JSON.stringify({ case: 'download', injected: errorCode, errorEvents: out.errorEvents,
      escaped: out.escaped?.code ?? null, activity: status.activity.install, emitted: events.at(-1), mutations }))
    assert.equal(out.escaped?.code ?? null, null, 'download errors must be consumed while awaiting the next body chunk')
    assert.equal(status.activity.install.running, false, 'disk failure must settle without waiting for more network bytes')
    assert.equal(status.activity.install.phase, 'failed')
    assert.equal(typeof status.activity.install.code, 'string')
    assert.equal(status.activity.install.code, 'LOCAL_SETUP_WRITE_FAILED', 'a disk that refuses is not a network problem')
    assert.equal(events.at(-1).phase, 'failed', 'the popup must receive the failure')
    assert.equal(mutations.includes('inert publish'), false)
  } finally {
    service.cancelInstall()
    await service.settled()
    service.stopAll()
    out.destroy()
    await turn()
    if (errorCode) assert.equal(cancelled, true, 'held in-memory body cancelled by cleanup')
  }
}

test('control: verified in-memory download completes without a real installer or file', t => downloadCase(t, null))
test('download: asynchronous EACCES is consumed and retained without another network chunk', t => downloadCase(t, 'EACCES'))

function archiveFile(name, body) {
  const header = Buffer.alloc(512)
  header.write(name, 0)
  header.write('0000755\0', 100)
  header.write('0000000\0', 108)
  header.write('0000000\0', 116)
  header.write(body.length.toString(8).padStart(11, '0') + '\0', 124)
  header.write('00000000000\0', 136)
  header.fill(0x20, 148, 156)
  header[156] = 0x30
  header.write('ustar\0', 257)
  const sum = header.reduce((n, value) => n + value, 0)
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
  const padding = Buffer.alloc((512 - body.length % 512) % 512)
  return Buffer.concat([header, body, padding, Buffer.alloc(1024)])
}

async function archiveCase(t, maximumWrite) {
  const payload = Buffer.from('fixture-ollama-program')
  const pieces = []
  let closed = false
  const fsApi = {
    async lstat() { throw diskError('ENOENT') }, async mkdir() {}, async chmod() {},
    async open() { return {
      async write(buffer, offset = 0, length = buffer.length - offset) {
        const accepted = Math.min(maximumWrite, length)
        pieces.push(Buffer.from(buffer.subarray(offset, offset + accepted)))
        return { bytesWritten: accepted, buffer }
      },
      async close() { closed = true },
    } },
  }
  async function *chunks() { yield archiveFile('bin/ollama', payload) }
  const result = await extractTar(chunks(), path.resolve('inert-t1701-archive'), { fsApi })
  const written = Buffer.concat(pieces)
  t.diagnostic(JSON.stringify({ case: 'archive', acceptedPerWrite: maximumWrite, actualBytes: written.length, reportedBytes: result.bytes, entries: result.entries, closed }))
  assert.equal(closed, true)
  assert.equal(result.entries, 1)
  assert.deepEqual(written, payload, 'published executable must contain the entire verified payload')
  assert.equal(result.bytes, payload.length)
}

test('control: full-write archive handle receives the complete payload and closes', t => archiveCase(t, Number.MAX_SAFE_INTEGER))
test('archive: short writes preserve the entire payload', t => archiveCase(t, 2))
