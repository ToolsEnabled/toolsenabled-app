'use strict'

/* SETTING UP A MODEL ON THIS COMPUTER, SHOWING ONLY THE STEPS STILL NEEDED.
 *
 * WHY IT EXISTS. On a computer with no Ollama at all, a Local agent answered
 * "Nothing was started. The chosen local runtime is unavailable. Start it and
 * check its address in Settings → Local models.", and nothing in the product
 * could get from there to a working model: the only install button ran
 * winget, so it refused on Linux with a `curl … | sh` line to paste, and the
 * download buttons needed an `ollama` program on PATH.
 *
 * THIS FILE IS THE MACHINE HALF OF THE "Set up local models" popup
 * (src/local-setup-popup.js draws it). It answers four questions and performs
 * four actions, and nothing else:
 *
 *   status()    Is Ollama here, is it answering at the saved Local models
 *               address, which models does it hold, and would a local agent
 *               start right now? The answering and readiness questions are
 *               asked of the ENGINE (probeRuntime and resolveLocalTarget, the
 *               same calls an agent start makes), never re-derived here.
 *   install()   Gets Ollama from its official release page only, verifies the
 *               SHA-256 its maintainers publish beside every release, and
 *               unpacks it into this app's own data folder -- no script piped
 *               to a shell, no administrator rights, nothing outside that
 *               folder. On Windows the verified per-user installer is kept
 *               until the person presses Run (runInstaller()).
 *   start()     Starts `ollama serve` on the saved address, tracked, and stops
 *               it with the app or on request.
 *   pull()      Downloads a model THROUGH OLLAMA (POST /api/pull), after a
 *               free-space check, with streamed progress and cancel.
 *
 * Saving the address and the default model is not here: the popup writes them
 * through window.mcSettings.setMany, the same validated and recorded path the
 * Settings page saves with. check() then asks the engine the start question
 * again.
 *
 * WORDS. Every refusal here is a code plus numbers; the sentences a person
 * reads are in src/local-model-setup-copy.js, where the plain-language gate
 * reads them.
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const crypto = require('node:crypto')
const zlib = require('node:zlib')
const { Readable, pipeline } = require('node:stream')
const { once } = require('node:events')
const { execFile, spawn: nodeSpawn } = require('node:child_process')

const GiB = 1024 ** 3
const MiB = 1024 ** 2
const DEFAULT_ADDRESS = 'http://127.0.0.1:11434'
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$/
const TAG_RE = /^v\d{1,4}\.\d{1,4}\.\d{1,4}$/
const PROBE_TIMEOUT_MS = 2_500
const START_WAIT_MS = 30_000
const STOP_WAIT_MS = 5_000
const PULL_STALL_MS = 120_000
const PROGRESS_EVERY_MS = 250
const MAX_TEXT_BYTES = 64 * 1024
const MAX_PULL_LINE_BYTES = 64 * 1024
const MAX_REDIRECTS = 5

/* WHERE OLLAMA MAY COME FROM. The release page, and the hosts GitHub serves
   that page's files from. Any other host, and any address that is not https,
   is refused before a byte is read. */
const OFFICIAL_RELEASES = Object.freeze({
  latest: 'https://github.com/ollama/ollama/releases/latest',
  download: tag => `https://github.com/ollama/ollama/releases/download/${tag}/`,
  checksums: 'sha256sum.txt',
  hosts: Object.freeze(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'github-releases.githubusercontent.com']),
})

/* The one file each platform needs, by the names the release page uses
   (v0.34.3, 2026-09-19). `unpackedFactor` is the free space the unpacked copy
   needs, as a multiple of the download: the Linux archive is zstd-compressed
   GPU libraries (measured on v0.34.3: 1.43 GB download, see RECEIPTS), the
   Windows installer is kept until it has run, and the macOS app unzips. */
function releaseAsset(platform, arch) {
  if (platform === 'linux') {
    if (arch === 'x64') return Object.freeze({ name: 'ollama-linux-amd64.tar.zst', kind: 'tar.zst', unpackedFactor: 3.5 })
    if (arch === 'arm64') return Object.freeze({ name: 'ollama-linux-arm64.tar.zst', kind: 'tar.zst', unpackedFactor: 3.5 })
    return null
  }
  if (platform === 'win32') {
    return arch === 'x64' || arch === 'arm64' ? Object.freeze({ name: 'OllamaSetup.exe', kind: 'installer', unpackedFactor: 4 }) : null
  }
  if (platform === 'darwin') return Object.freeze({ name: 'Ollama-darwin.zip', kind: 'app-zip', unpackedFactor: 2 })
  return null
}

/* `<sha256>  ./<file>` per line, the shape sha256sum writes and the release
   page publishes. A file listed twice with different sums is refused rather
   than guessed between. */
function parseChecksums(text) {
  const sums = new Map()
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(?:\.\/)?([^\s/\\]+)\s*$/.exec(line.trim())
    if (!match) continue
    const [, hex, name] = match
    const sum = hex.toLowerCase()
    if (sums.has(name) && sums.get(name) !== sum) return null
    sums.set(name, sum)
  }
  return sums
}

function setupError(code, details = {}) {
  const error = new Error(code)
  error.code = code
  error.details = details
  return error
}

function refusal(code, details = {}) {
  return { ok: false, code, ...details }
}

/* ------------------------------------------------------------ addresses -- */

/* The Local models "Service address", read the way the engine reads it
   (local-model-options.parseOllamaEndpoint): a plain http address with no
   path, query or credential. An empty setting means "not set yet" and the
   popup uses Ollama's own default. A saved address this cannot use is
   reported, never silently replaced. */
function localAddress(saved) {
  const text = typeof saved === 'string' ? saved.trim() : ''
  const chosen = text || DEFAULT_ADDRESS
  let url
  try { url = new URL(chosen) } catch { return { url: chosen, host: null, port: null, saved: Boolean(text), usable: false, local: false } }
  const usable = url.protocol === 'http:' && !url.username && !url.password && !url.search && !url.hash
    && ['', '/'].includes(url.pathname)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const port = url.port ? Number(url.port) : 80
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
  return {
    url: usable ? `http://${url.host}` : chosen,
    host: host === 'localhost' ? '127.0.0.1' : host,
    port,
    saved: Boolean(text),
    usable,
    local: usable && loopback,
  }
}

/* OLLAMA_HOST for a server this app starts: the saved address's own host and
   port, so what starts is exactly what the settings will point at. */
function hostVariable(address) {
  return address.host.includes(':') ? `[${address.host}]:${address.port}` : `${address.host}:${address.port}`
}

/* --------------------------------------------------------- the archive -- */

/* A path inside the archive that stays inside the folder it unpacks into.
   Absolute paths, drive letters, `..` and backslashes are refused outright;
   `./` and empty segments are dropped. */
function safeArchivePath(name) {
  const text = String(name || '')
  if (!text || text.includes('\0') || text.includes('\\')) return null
  if (text.startsWith('/') || /^[A-Za-z]:/.test(text)) return null
  const parts = text.split('/').filter(part => part && part !== '.')
  if (parts.some(part => part === '..')) return null
  return parts.join('/')
}

function headerString(block, start, length) {
  const field = block.subarray(start, start + length)
  const end = field.indexOf(0)
  return field.subarray(0, end === -1 ? field.length : end).toString('utf8')
}

function headerNumber(block, start, length) {
  const field = block.subarray(start, start + length)
  if (field[0] & 0x80) {
    let value = BigInt(field[0] & 0x7f)
    for (let index = 1; index < field.length; index += 1) value = (value << 8n) + BigInt(field[index])
    return Number(value)
  }
  const text = field.toString('latin1').replace(/\0[\s\S]*$/, '').trim()
  if (!text) return 0
  if (!/^[0-7]+$/.test(text)) throw setupError('LOCAL_SETUP_ARCHIVE_INVALID', { reason: 'number' })
  return parseInt(text, 8)
}

function headerChecksumOk(block) {
  let sum = 0
  for (let index = 0; index < 512; index += 1) sum += index >= 148 && index < 156 ? 0x20 : block[index]
  return sum === headerNumber(block, 148, 8)
}

function paxRecords(buffer) {
  const records = {}
  let offset = 0
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset)
    if (space === -1) break
    const length = Number(buffer.toString('latin1', offset, space))
    if (!Number.isInteger(length) || length <= 0 || offset + length > buffer.length) break
    const record = buffer.toString('utf8', space + 1, offset + length - 1)
    const equals = record.indexOf('=')
    if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1)
    offset += length
  }
  return records
}

/* Reads exactly the bytes asked for from an async sequence of chunks, so the
   tar reader below streams file bodies straight to disk instead of holding a
   multi-gigabyte archive in memory. */
class ChunkReader {
  constructor(chunks) {
    this.iterator = chunks[Symbol.asyncIterator]()
    this.buffer = Buffer.alloc(0)
    this.offset = 0
    this.done = false
  }

  available() { return this.buffer.length - this.offset }

  async fill() {
    if (this.done) return false
    const next = await this.iterator.next()
    if (next.done) { this.done = true; return false }
    const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value)
    this.buffer = this.available() > 0 ? Buffer.concat([this.buffer.subarray(this.offset), chunk]) : chunk
    this.offset = 0
    return true
  }

  async read(length) {
    while (this.available() < length) {
      if (!await this.fill()) return null
    }
    const out = this.buffer.subarray(this.offset, this.offset + length)
    this.offset += length
    return out
  }

  async stream(length, write) {
    let left = length
    while (left > 0) {
      if (this.available() === 0 && !await this.fill()) throw setupError('LOCAL_SETUP_ARCHIVE_INVALID', { reason: 'truncated' })
      const take = Math.min(left, this.available())
      await write(this.buffer.subarray(this.offset, this.offset + take))
      this.offset += take
      left -= take
    }
  }
}

/* A FILE WRITE MAY TAKE FEWER BYTES THAN IT WAS GIVEN (FileHandle.write
   answers how many it wrote). The rest is written until nothing is left, so
   the unpacked program holds every byte the checksum covered; a write that
   takes nothing at all stops the unpack instead of looping. */
async function writeAll(handle, buffer) {
  let offset = 0
  while (offset < buffer.length) {
    const answer = await handle.write(buffer, offset, buffer.length - offset)
    const written = answer && Number.isSafeInteger(answer.bytesWritten) ? answer.bytesWritten : 0
    if (written <= 0) throw setupError('LOCAL_SETUP_WRITE_FAILED', { reason: 'no-progress' })
    offset += written
  }
  return offset
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/* Every folder between the destination and a file is made one level at a
   time, and a level that is a link is refused: a link written earlier in the
   archive must never carry a later file out of the destination. */
async function ensureDirectory(root, relativeDirectory, fsApi) {
  let current = root
  for (const part of relativeDirectory ? relativeDirectory.split('/') : []) {
    current = path.join(current, part)
    let stat = null
    try { stat = await fsApi.lstat(current) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (!stat) { await fsApi.mkdir(current, { mode: 0o755 }); continue }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw setupError('LOCAL_SETUP_ARCHIVE_INVALID', { reason: 'path', entry: relativeDirectory })
  }
  return current
}

/* A USTAR/PAX/GNU tar reader, only as wide as a release archive needs:
   files, folders, and links that stay inside the destination. Anything else
   (devices, pipes, a link that leaves the folder) refuses the whole archive,
   and the caller deletes what was written. */
async function extractTar(chunks, destination, { fsApi = fsp, onEntry = () => {}, signal = null } = {}) {
  const reader = new ChunkReader(chunks)
  const root = path.resolve(destination)
  let pending = {}
  let entries = 0
  let bytes = 0
  let zeroBlocks = 0
  for (;;) {
    if (signal?.aborted) throw setupError('LOCAL_SETUP_CANCELLED')
    const block = await reader.read(512)
    if (!block) break
    if (block.every(byte => byte === 0)) {
      zeroBlocks += 1
      if (zeroBlocks >= 2) break
      continue
    }
    zeroBlocks = 0
    if (!headerChecksumOk(block)) throw setupError('LOCAL_SETUP_ARCHIVE_INVALID', { reason: 'checksum' })
    const type = String.fromCharCode(block[156] || 48)
    let size = headerNumber(block, 124, 12)
    const padded = Math.ceil(size / 512) * 512
    if (type === 'x' || type === 'g' || type === 'L' || type === 'K') {
      if (size > 1024 * 1024) throw setupError('LOCAL_SETUP_ARCHIVE_INVALID', { reason: 'header' })
      const body = await reader.read(padded)
      if (!body) throw setupError('LOCAL_SETUP_ARCHIVE_INVALID', { reason: 'truncated' })
      const data = body.subarray(0, size)
      if (type === 'x') pending = { ...pending, ...paxRecords(data) }
      else if (type === 'L') pending.path = data.toString('utf8').replace(/\0[\s\S]*$/, '')
      else if (type === 'K') pending.linkpath = data.toString('utf8').replace(/\0[\s\S]*$/, '')
      continue
    }
    const magic = block.toString('latin1', 257, 262)
    const prefix = magic === 'ustar' ? headerString(block, 345, 155) : ''
    const rawName = pending.path || (prefix ? `${prefix}/${headerString(block, 0, 100)}` : headerString(block, 0, 100))
    const linkName = pending.linkpath || headerString(block, 157, 100)
    if (pending.size !== undefined) {
      const paxSize = Number(pending.size)
      if (!Number.isSafeInteger(paxSize) || paxSize < 0) throw setupError('LOCAL_SETUP_ARCHIVE_INVALID', { reason: 'size' })
      size = paxSize
    }
    pending = {}
    const mode = headerNumber(block, 100, 8)
    const name = safeArchivePath(rawName)
    if (name === null) throw setupError('LOCAL_SETUP_ARCHIVE_INVALID', { reason: 'path', entry: rawName.slice(0, 200) })
    const dataLength = Math.ceil(size / 512) * 512
    if (!name) { await reader.stream(dataLength, async () => {}); continue }
    const target = path.join(root, ...name.split('/'))
    if (!inside(root, target)) throw setupError('LOCAL_SETUP_ARCHIVE_INVALID', { reason: 'path', entry: name })
    const parentRelative = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : ''
    if (type === '5') {
      await ensureDirectory(root, name, fsApi)
      await reader.stream(dataLength, async () => {})
    } else if (type === '0' || type === '\0' || type === '7') {
      await ensureDirectory(root, parentRelative, fsApi)
      await removeIfLink(target, fsApi)
      const handle = await fsApi.open(target, 'w', (mode & 0o111) ? 0o755 : 0o644)
      try {
        let left = size
        await reader.stream(dataLength, async chunk => {
          const useful = left > 0 ? chunk.subarray(0, Math.min(left, chunk.length)) : null
          if (useful && useful.length) {
            const written = await writeAll(handle, useful)
            left -= written
            bytes += written
          }
        })
      } finally {
        await handle.close()
      }
      if (typeof fsApi.chmod === 'function') await fsApi.chmod(target, (mode & 0o111) ? 0o755 : 0o644)
    } else if (type === '2') {
      const link = String(linkName || '')
      if (!link || path.isAbsolute(link) || link.includes('\\') || link.includes('\0')) {
        throw setupError('LOCAL_SETUP_ARCHIVE_INVALID', { reason: 'link', entry: name })
      }
      const resolved = path.resolve(path.dirname(target), link)
      if (!inside(root, resolved)) throw setupError('LOCAL_SETUP_ARCHIVE_INVALID', { reason: 'link', entry: name })
      await ensureDirectory(root, parentRelative, fsApi)
      await removeIfLink(target, fsApi)
      await fsApi.symlink(link, target)
      await reader.stream(dataLength, async () => {})
    } else if (type === '1') {
      const source = safeArchivePath(linkName)
      if (!source) throw setupError('LOCAL_SETUP_ARCHIVE_INVALID', { reason: 'link', entry: name })
      const from = path.join(root, ...source.split('/'))
      await ensureDirectory(root, parentRelative, fsApi)
      await removeIfLink(target, fsApi)
      await fsApi.copyFile(from, target)
      await reader.stream(dataLength, async () => {})
    } else {
      throw setupError('LOCAL_SETUP_ARCHIVE_INVALID', { reason: 'type', entry: name })
    }
    entries += 1
    onEntry({ name, entries, bytes })
  }
  if (entries === 0) throw setupError('LOCAL_SETUP_ARCHIVE_INVALID', { reason: 'empty' })
  return { entries, bytes }
}

async function removeIfLink(target, fsApi) {
  let stat = null
  try { stat = await fsApi.lstat(target) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (!stat) return
  if (stat.isDirectory() && !stat.isSymbolicLink()) throw setupError('LOCAL_SETUP_ARCHIVE_INVALID', { reason: 'path' })
  await fsApi.unlink(target)
}

/* ------------------------------------------------------------- service -- */

function createLocalModelSetup({
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  dataDirectory,
  localNodeRuntime = null,
  localNodeProcess = null,
  readSettingsValues = () => ({}),
  fetchImpl = globalThis.fetch,
  httpImpl = http,
  fsApi = fsp,
  fsSync = fs,
  spawnServe = null,
  spawnInstaller = (command, args, options) => nodeSpawn(command, args, options),
  runFile = (command, args, options, callback) => execFile(command, args, options, callback),
  totalMemory = () => os.totalmem(),
  freeMemory = () => os.freemem(),
  freeDisk = null,
  isolated = false,
  now = () => Date.now(),
  timers = { setTimeout, clearTimeout },
} = {}) {
  if (typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory)) throw new TypeError('createLocalModelSetup() needs an absolute data folder')
  const root = path.join(dataDirectory, 'local-models')
  const paths = Object.freeze({
    root,
    program: path.join(root, 'ollama'),
    app: path.join(root, 'app'),
    downloads: path.join(root, 'downloads'),
    models: path.join(root, 'models'),
    home: path.join(root, 'home'),
    logs: path.join(root, 'logs'),
  })
  const exe = platform === 'win32' ? 'ollama.exe' : 'ollama'
  const home = platform === 'win32' ? (env.USERPROFILE || env.HOME || '') : (env.HOME || '')

  let installFlight = null
  let pullFlight = null
  let serve = null
  let installerFlight = null
  let lastInstall = null
  let lastPull = null
  /* Why the log of the Ollama this app started could not be written, or
     null. Kept for status() until the next start; Ollama itself keeps
     running without its log. */
  let serveLogProblem = null
  /* The verified Windows installer waiting for the person's press. Its file
     and sum stay in this process; the window is told only that it is ready. */
  let pendingInstaller = null
  let machineCache = null

  const statDisk = freeDisk || (directory => {
    let current = path.resolve(directory)
    for (;;) {
      try {
        const stats = fsSync.statfsSync(current)
        return Number(stats.bavail) * Number(stats.bsize)
      } catch (error) {
        const parent = path.dirname(current)
        if (error.code !== 'ENOENT' || parent === current) return null
        current = parent
      }
    }
  })

  function exists(file) {
    try { return fsSync.statSync(file).isFile() } catch { return false }
  }

  /* The app's own copy first (this app manages it), then the program the
     person may already have: PATH, then each platform's usual install place. */
  function appCopy() {
    if (platform === 'darwin') {
      const binary = path.join(paths.app, 'Ollama.app', 'Contents', 'Resources', 'ollama')
      return exists(binary) ? binary : null
    }
    if (platform === 'win32') return null
    const binary = path.join(paths.program, 'bin', exe)
    return exists(binary) ? binary : null
  }

  function systemCopy() {
    const found = []
    const search = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)
    for (const directory of search) found.push(path.join(directory, exe))
    if (platform === 'win32') {
      if (env.LOCALAPPDATA) found.push(path.join(env.LOCALAPPDATA, 'Programs', 'Ollama', exe))
      if (env.ProgramFiles) found.push(path.join(env.ProgramFiles, 'Ollama', exe))
    } else if (platform === 'darwin') {
      found.push('/Applications/Ollama.app/Contents/Resources/ollama')
      if (home) found.push(path.join(home, 'Applications', 'Ollama.app', 'Contents', 'Resources', 'ollama'))
      found.push('/usr/local/bin/ollama', '/opt/homebrew/bin/ollama')
    } else {
      found.push('/usr/local/bin/ollama', '/usr/bin/ollama')
      if (home) found.push(path.join(home, '.local', 'bin', 'ollama'))
    }
    return found.find(exists) || null
  }

  function program() {
    const own = appCopy()
    if (own) return { file: own, appCopy: true }
    const system = systemCopy()
    return system ? { file: system, appCopy: false } : null
  }

  function settingsNow() {
    try {
      const values = readSettingsValues()
      return values && typeof values === 'object' ? { ok: true, values } : { ok: false, values: {} }
    } catch (error) {
      return { ok: false, values: {}, code: typeof error?.code === 'string' ? error.code : 'LOCAL_NODE_SETTINGS_INVALID' }
    }
  }

  function chosenModel(values) {
    const agent = String(values['model.local_agent_name'] || '').trim()
    if (agent) return agent
    return values['model.provider'] === 'Ollama' ? String(values['model.name'] || '').trim() : ''
  }

  /* The engine's own rule (local-model-options.installedModel): the exact
     name, or `name:latest` for a name given without a tag. */
  function installedName(model, models) {
    if (!model) return null
    if (models.includes(model)) return model
    return !model.includes(':') && models.includes(`${model}:latest`) ? `${model}:latest` : null
  }

  /* The size of each model this Ollama already holds (GET /api/tags), so a
     downloaded model is warned about the same way as one still to download.
     Bounded, and optional: no answer leaves the sizes unknown. */
  async function heldSizes(address) {
    if (!localNodeRuntime || typeof localNodeRuntime.boundedJsonRequest !== 'function') return new Map()
    try {
      const payload = await localNodeRuntime.boundedJsonRequest({ host: address.host, port: address.port, path: '/api/tags', timeoutMs: PROBE_TIMEOUT_MS }, { http: httpImpl })
      const rows = Array.isArray(payload?.models) ? payload.models : []
      return new Map(rows.filter(row => row && typeof row.name === 'string' && Number.isFinite(row.size)).map(row => [row.name, row.size]))
    } catch {
      return new Map()
    }
  }

  async function probe(address) {
    if (!address.usable) return { answering: 'no', models: [], version: null }
    if (!localNodeRuntime || typeof localNodeRuntime.probeRuntime !== 'function') return { answering: 'unknown', models: [], version: null }
    try {
      const found = await localNodeRuntime.probeRuntime('ollama', { host: address.host, port: address.port, timeoutMs: PROBE_TIMEOUT_MS }, { http: httpImpl, platform })
      if (!found.listening) return { answering: 'no', models: [], version: null }
      const version = typeof localNodeRuntime.readRuntimeVersion === 'function'
        ? await localNodeRuntime.readRuntimeVersion('ollama', { host: address.host, port: address.port, timeoutMs: PROBE_TIMEOUT_MS }, { http: httpImpl })
        : null
      return { answering: 'yes', models: [...found.models], version }
    } catch (error) {
      /* A MODEL LIST THAT CANNOT BE READ IS NOT "NOBODY ANSWERED". An engine
         from before da303d38 reads a freshly installed Ollama's empty list
         ("data": null) as malformed; Ollama's own version route (the engine's
         bounded readRuntimeVersion) still says whether it is running, so
         Start and the model step are not blocked by the list's shape. */
      const version = typeof localNodeRuntime.readRuntimeVersion === 'function'
        ? await localNodeRuntime.readRuntimeVersion('ollama', { host: address.host, port: address.port, timeoutMs: PROBE_TIMEOUT_MS }, { http: httpImpl })
        : null
      if (version) return { answering: 'yes', models: [], version, listUnread: true }
      return { answering: 'unknown', models: [], version: null, code: typeof error?.code === 'string' ? error.code : null }
    }
  }

  /* NVIDIA's own tool, asked once, bounded. The engine's probeResources()
     answers FREE memory, which drops whenever another model is loaded; "does
     this model fit this computer" is a question about the card's size, so
     both numbers are read here and the card's size decides. */
  function readGpu() {
    return new Promise(resolve => {
      try {
        runFile(platform === 'win32' ? 'nvidia-smi.exe' : 'nvidia-smi', ['--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits'],
          { timeout: 3_000, windowsHide: true, maxBuffer: 64 * 1024 }, (error, stdout) => {
            if (error) return resolve(null)
            const rows = String(stdout || '').split(/\r?\n/).map(line => line.split(',').map(cell => cell.trim()))
              .filter(cells => cells.length >= 3 && /^\d+(\.\d+)?$/.test(cells[1]))
            if (!rows.length) return resolve(null)
            const best = rows.reduce((a, b) => (Number(b[1]) > Number(a[1]) ? b : a))
            resolve({ name: best[0].slice(0, 80), vramBytes: Math.floor(Number(best[1]) * MiB), freeVramBytes: /^\d+(\.\d+)?$/.test(best[2]) ? Math.floor(Number(best[2]) * MiB) : null })
          })
      } catch { resolve(null) }
    })
  }

  async function hardware() {
    if (machineCache && now() - machineCache.at < 10_000) return machineCache.value
    const ramBytes = Number(totalMemory()) || null
    const freeRamBytes = Number(freeMemory()) || null
    let gpu = await readGpu()
    /* Apple silicon shares memory with its graphics; Ollama places models
       there and reports them as graphics memory. */
    if (!gpu && platform === 'darwin' && arch === 'arm64' && ramBytes) gpu = { name: 'Apple silicon', vramBytes: Math.floor(ramBytes * 0.66), freeVramBytes: null }
    const value = { ramBytes, freeRamBytes, vramBytes: gpu?.vramBytes ?? null, freeVramBytes: gpu?.freeVramBytes ?? null, gpuName: gpu?.name ?? null }
    machineCache = { at: now(), value }
    return value
  }

  /* WHETHER A MODEL FITS THIS COMPUTER, by the engine's own rule. The need is
     the engine's CURATED_MODELS minFreeVramBytes, and assertModelFits() is
     asked with the card's size in place of its free memory. With no card to
     measure, system memory decides whether it can run on the processor. */
  function fitFor(model, machine) {
    const need = Number(model?.minFreeVramBytes)
    if (!Number.isFinite(need) || need <= 0) return 'unknown'
    if (Number.isFinite(machine.vramBytes) && machine.vramBytes > 0) {
      let fits = machine.vramBytes >= need
      /* A model on the engine's own list is judged by the engine's own rule;
         anything else by the same comparison with the need given here. */
      const listed = localNodeRuntime && typeof localNodeRuntime.curatedModel === 'function' ? localNodeRuntime.curatedModel(model.id) : null
      if (listed && listed.minFreeVramBytes === need && typeof localNodeRuntime.assertModelFits === 'function') {
        try { localNodeRuntime.assertModelFits(model.id, { freeVramBytes: machine.vramBytes }); fits = true } catch (error) {
          fits = error?.code === 'LOCAL_NODE_MODEL_WILL_NOT_FIT' ? false : fits
        }
      }
      if (fits) return 'gpu'
    }
    if (Number.isFinite(machine.ramBytes) && need <= machine.ramBytes * 0.6) return 'cpu'
    return Number.isFinite(machine.ramBytes) ? 'too-big' : 'unknown'
  }

  /* CLOSE TO WHAT IS FREE RIGHT NOW. Loading a model takes its memory from
     the graphics card first and the rest from system memory. A model whose
     need is near what both have free at this moment can starve the computer,
     up to an unexpected restart, so the popup warns before such a choice. Free
     memory that could not be read is not a reason to warn. */
  function tightFor(needBytes, machine) {
    if (!Number.isFinite(needBytes) || needBytes <= 0 || !Number.isFinite(machine.freeRamBytes)) return false
    const free = machine.freeRamBytes + (Number.isFinite(machine.freeVramBytes) ? machine.freeVramBytes : 0)
    return needBytes > free * 0.8
  }

  /* Where the models of the Ollama at this address are kept, for the free
     space check: this app's own folder when this app's copy serves them, the
     program's usual folder otherwise. */
  function modelsFolder(found) {
    if (serve || found?.appCopy) return paths.models
    if (env.OLLAMA_MODELS) return env.OLLAMA_MODELS
    return path.join(home || os.homedir(), '.ollama', 'models')
  }

  function curated() {
    const list = localNodeRuntime && Array.isArray(localNodeRuntime.CURATED_MODELS) ? localNodeRuntime.CURATED_MODELS : []
    return list.filter(entry => entry && typeof entry.id === 'string' && MODEL_ID_RE.test(entry.id))
  }

  /* What the window may know about work in progress: phases, counts, codes.
     Never a path. */
  const INSTALL_FIELDS = ['phase', 'version', 'received', 'total', 'code', 'needBytes', 'freeBytes']
  const PULL_FIELDS = ['model', 'phase', 'status', 'completed', 'total', 'code', 'detail', 'needBytes', 'freeBytes']
  const pick = (source, fields) => Object.fromEntries(fields.filter(key => source[key] !== undefined).map(key => [key, source[key]]))

  function installProgress() {
    if (installFlight) return { ...pick(installFlight.progress, INSTALL_FIELDS), running: true }
    return lastInstall ? { ...pick(lastInstall, INSTALL_FIELDS), running: false } : null
  }

  function pullProgress() {
    if (pullFlight) return { ...pick(pullFlight.progress, PULL_FIELDS), running: true }
    return lastPull ? { ...pick(lastPull, PULL_FIELDS), running: false } : null
  }

  async function readiness() {
    if (!localNodeProcess || typeof localNodeProcess.resolveLocalTarget !== 'function') return { ready: false, code: 'LOCAL_SETUP_ENGINE_UNAVAILABLE' }
    try {
      const target = await localNodeProcess.resolveLocalTarget()
      return { ready: true, code: null, model: target?.model || null, endpoint: target?.endpoint || null }
    } catch (error) {
      return { ready: false, code: typeof error?.code === 'string' ? error.code : 'LOCAL_NODE_RUNTIME_UNAVAILABLE' }
    }
  }

  async function status() {
    const settings = settingsNow()
    const values = settings.values
    const address = localAddress(values['model.endpoint'])
    const found = program()
    const answer = await probe(address)
    const machine = await hardware()
    const wanted = chosenModel(values)
    const installedWanted = installedName(wanted, answer.models)
    const provider = String(values['model.provider'] || '')
    const saved = provider === 'Ollama' && address.saved
    let ready = { ready: false, code: null }
    if (settings.ok && saved && answer.answering === 'yes' && installedWanted) ready = await readiness()
    const models = answer.models
    const sizes = answer.answering === 'yes' ? await heldSizes(address) : new Map()
    const catalogue = curated().map(entry => {
      const downloadBytes = Number.isFinite(entry.downloadBytes) ? entry.downloadBytes : null
      const needBytes = Number.isFinite(entry.minFreeVramBytes) ? entry.minFreeVramBytes : null
      return {
        id: entry.id,
        label: typeof entry.label === 'string' ? entry.label : entry.id,
        downloadBytes,
        needBytes,
        downloaded: Boolean(installedName(entry.id, models)),
        fit: fitFor(entry, machine),
        tight: tightFor(needBytes, machine),
      }
    })
    /* Downloaded models outside the list: their size on disk stands in for
       the memory they need, plus a fifth for the conversation they hold. */
    const held = models.map(id => {
      const listed = catalogue.find(entry => installedName(entry.id, [id]))
      if (listed) return { id, label: listed.label, sizeBytes: sizes.get(id) ?? listed.downloadBytes, fit: listed.fit, tight: listed.tight, listed: true }
      const sizeBytes = sizes.has(id) ? sizes.get(id) : null
      const needBytes = Number.isFinite(sizeBytes) ? Math.ceil(sizeBytes * 1.2) : null
      const fit = Number.isFinite(needBytes) ? fitFor({ id, minFreeVramBytes: needBytes }, machine) : 'unknown'
      return { id, label: id, sizeBytes, fit, tight: tightFor(needBytes, machine), listed: false }
    })
    /* PREFER WHAT FITS THE GRAPHICS CARD, WITH ROOM TO SPARE. The suggested
       model is the largest one whose need leaves a sixth of the card free (a
       laptop card also draws the screen) and that is not tight right now; if
       none leaves that room, the smallest that fits the card; with no card to
       use, the smallest one that runs on the processor. */
    const gpuFits = catalogue.filter(entry => entry.fit === 'gpu' && !entry.tight)
    const roomy = gpuFits.filter(entry => !Number.isFinite(machine.vramBytes) || entry.needBytes <= machine.vramBytes * 0.85)
    const cpuFits = catalogue.filter(entry => entry.fit === 'cpu' && !entry.tight)
    /* Ties go to the entry listed first (the general model before a
       specialised one of the same size). */
    const largest = list => list.reduce((best, entry) => ((entry.needBytes ?? 0) > (best.needBytes ?? 0) ? entry : best))
    const smallest = list => list.reduce((best, entry) => ((entry.needBytes ?? 0) < (best.needBytes ?? 0) ? entry : best))
    const recommended = roomy.length ? largest(roomy).id
      : gpuFits.length ? smallest(gpuFits).id
        : cpuFits.length ? smallest(cpuFits).id : null
    const asset = releaseAsset(platform, arch)
    const folder = modelsFolder(found)
    return {
      ok: true,
      platform,
      isolated: Boolean(isolated),
      settingsReadable: settings.ok,
      settingsCode: settings.ok ? null : settings.code || 'LOCAL_NODE_SETTINGS_INVALID',
      address,
      provider,
      savedEndpoint: String(values['model.endpoint'] || ''),
      gpuPolicy: String(values['model.local_gpu_policy'] || 'Require GPU'),
      installed: Boolean(found),
      appCopy: Boolean(found?.appCopy),
      running: answer.answering === 'yes',
      answering: answer.answering,
      version: answer.version,
      startedHere: Boolean(serve && !serve.exited),
      logProblem: serveLogProblem,
      models,
      held,
      recommended,
      chosen: { model: wanted || null, installed: Boolean(installedWanted), name: installedWanted || null, saved },
      ready: ready.ready,
      readyCode: ready.code,
      hardware: { ...machine, freeDiskBytes: statDisk(folder) },
      catalogue,
      installSupported: Boolean(asset),
      installKind: asset ? asset.kind : null,
      installerReady: Boolean(platform === 'win32' && pendingInstaller && exists(pendingInstaller.file)),
      activity: { install: installProgress(), pull: pullProgress() },
    }
  }

  /* ------------------------------------------------ the official download -- */

  async function officialResponse(url, signal) {
    if (typeof fetchImpl !== 'function') throw setupError('LOCAL_SETUP_NETWORK')
    let current = url
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      let parsed
      try { parsed = new URL(current) } catch { throw setupError('LOCAL_SETUP_SOURCE_REFUSED') }
      if (parsed.protocol !== 'https:' || !OFFICIAL_RELEASES.hosts.includes(parsed.hostname)) {
        throw setupError('LOCAL_SETUP_SOURCE_REFUSED', { host: parsed.hostname })
      }
      let response
      try {
        response = await fetchImpl(current, { redirect: 'manual', signal, headers: { 'user-agent': 'ToolsEnabled local model setup' } })
      } catch (error) {
        if (signal?.aborted) throw setupError('LOCAL_SETUP_CANCELLED')
        throw setupError('LOCAL_SETUP_NETWORK', { cause: error?.code || error?.name || null })
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location')
        try { await response.body?.cancel?.() } catch { /* nothing to read */ }
        if (!location) throw setupError('LOCAL_SETUP_SOURCE_REFUSED')
        current = new URL(location, current).toString()
        continue
      }
      if (response.status < 200 || response.status >= 300) {
        try { await response.body?.cancel?.() } catch { /* nothing to read */ }
        throw setupError('LOCAL_SETUP_NETWORK', { status: response.status })
      }
      return response
    }
    throw setupError('LOCAL_SETUP_SOURCE_REFUSED')
  }

  /* The newest release, named by the page GitHub sends "latest" to. It is not
     followed: the tag is read from where it points, and both files are then
     fetched from that one release, so the checksum and the program always
     belong together. */
  async function latestTag(signal) {
    let response
    try {
      response = await fetchImpl(OFFICIAL_RELEASES.latest, { redirect: 'manual', signal, headers: { 'user-agent': 'ToolsEnabled local model setup' } })
    } catch (error) {
      if (signal?.aborted) throw setupError('LOCAL_SETUP_CANCELLED')
      throw setupError('LOCAL_SETUP_NETWORK', { cause: error?.code || error?.name || null })
    }
    try { await response.body?.cancel?.() } catch { /* nothing to read */ }
    const location = response.headers.get('location') || ''
    const match = /\/ollama\/ollama\/releases\/tag\/([^/?#]+)$/.exec(location)
    if (!match || !TAG_RE.test(match[1])) throw setupError('LOCAL_SETUP_RELEASE_UNKNOWN')
    return match[1]
  }

  async function readText(response) {
    const chunks = []
    let size = 0
    for await (const chunk of Readable.fromWeb(response.body)) {
      size += chunk.length
      if (size > MAX_TEXT_BYTES) throw setupError('LOCAL_SETUP_CHECKSUM_UNPUBLISHED')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  /* At most a few packets a second, and never the last one lost: a packet
     held back inside the window is sent when the window ends, unless a newer
     one (or a forced one, such as the final state) replaces it first. */
  function throttle(emit) {
    let last = 0
    let pending = null
    let timer = null
    const send = packet => {
      last = now()
      try { emit(packet) } catch { /* a closed window stops reading, the work continues */ }
    }
    return (packet, force = false) => {
      const at = now()
      if (force || at - last >= PROGRESS_EVERY_MS) {
        if (timer) { timers.clearTimeout(timer); timer = null; pending = null }
        send(packet)
        return
      }
      pending = packet
      if (!timer) {
        timer = timers.setTimeout(() => {
          timer = null
          const held = pending
          pending = null
          if (held) send(held)
        }, Math.max(1, PROGRESS_EVERY_MS - (at - last)))
      }
    }
  }

  async function removeQuietly(target) {
    try { await fsApi.rm(target, { recursive: true, force: true }) } catch { /* best effort */ }
  }

  async function sha256Of(file) {
    const hash = crypto.createHash('sha256')
    for await (const chunk of fsSync.createReadStream(file)) hash.update(chunk)
    return hash.digest('hex')
  }

  async function runInstall(flight) {
    const { asset, controller } = flight
    const signal = controller.signal
    const progress = (fields, force) => {
      flight.progress = { ...flight.progress, ...fields }
      flight.report({ kind: 'install', ...pick(flight.progress, INSTALL_FIELDS) }, force)
    }
    progress({ phase: 'release', received: 0, total: null }, true)
    const tag = await latestTag(signal)
    const base = OFFICIAL_RELEASES.download(tag)
    const sums = parseChecksums(await readText(await officialResponse(base + OFFICIAL_RELEASES.checksums, signal)))
    const expected = sums && sums.get(asset.name)
    if (!expected) throw setupError('LOCAL_SETUP_CHECKSUM_UNPUBLISHED', { asset: asset.name })
    const response = await officialResponse(base + asset.name, signal)
    const total = Number(response.headers.get('content-length')) || null
    await fsApi.mkdir(paths.downloads, { recursive: true, mode: 0o700 })
    const free = statDisk(paths.root)
    const need = total ? Math.ceil(total * (1 + asset.unpackedFactor)) + 256 * MiB : null
    if (need && Number.isFinite(free) && free < need) {
      try { await response.body?.cancel?.() } catch { /* not reading it */ }
      throw setupError('LOCAL_SETUP_DISK_FULL', { needBytes: need, freeBytes: free })
    }
    const file = path.join(paths.downloads, asset.name)
    const partial = `${file}.partial`
    flight.cleanup.push(partial)
    const hash = crypto.createHash('sha256')
    /* Cancel ends the read at once, even while the connection is silent. */
    const body = Readable.fromWeb(response.body)
    const stopReading = () => body.destroy(setupError('LOCAL_SETUP_CANCELLED'))
    /* A DISK ERROR ARRIVES LATER THAN THE WRITE. write() accepts a chunk and
       the file stream reports its failure afterwards, on its own 'error'
       event -- often while the loop below waits on a silent connection for
       the next chunk. The error is taken here (an 'error' nobody listens to
       is thrown in the main process) and ends the read at once, so the
       download fails now, with the disk's reason, instead of waiting. */
    let writeError = null
    const out = fsSync.createWriteStream(partial, { mode: 0o600 })
    out.on('error', error => {
      if (writeError) return
      writeError = error || setupError('LOCAL_SETUP_WRITE_FAILED')
      body.destroy(writeError)
    })
    let received = 0
    progress({ phase: 'download', version: tag, received, total }, true)
    signal.addEventListener('abort', stopReading, { once: true })
    try {
      for await (const chunk of body) {
        if (signal.aborted) throw setupError('LOCAL_SETUP_CANCELLED')
        hash.update(chunk)
        received += chunk.length
        if (!out.write(chunk)) await once(out, 'drain')
        progress({ received })
      }
      await new Promise((resolve, reject) => out.end(error => (error ? reject(error) : resolve())))
    } catch (error) {
      out.destroy()
      if (signal.aborted) throw setupError('LOCAL_SETUP_CANCELLED')
      const failure = writeError || error
      if (failure?.code === 'ENOSPC' || failure?.code === 'EDQUOT') throw setupError('LOCAL_SETUP_DISK_FULL', { needBytes: need, freeBytes: statDisk(paths.root) })
      if (failure?.code && String(failure.code).startsWith('LOCAL_SETUP_')) throw failure
      /* The disk said no for another reason (no permission, a read-only
         folder): that is not the network, and the words must not say so. */
      if (writeError) throw setupError('LOCAL_SETUP_WRITE_FAILED', { cause: writeError.code || writeError.name || null })
      throw setupError('LOCAL_SETUP_NETWORK', { cause: error?.code || error?.name || null })
    } finally {
      signal.removeEventListener('abort', stopReading)
    }
    progress({ phase: 'verify', received, total }, true)
    const actual = hash.digest('hex')
    if ((total && received !== total) || actual !== expected) {
      await removeQuietly(partial)
      throw setupError('LOCAL_SETUP_CHECKSUM_MISMATCH', { asset: asset.name })
    }
    await fsApi.rename(partial, file)
    flight.cleanup = flight.cleanup.filter(entry => entry !== partial)
    if (asset.kind === 'installer') {
      /* Nothing runs yet. The verified installer waits for the person's own
         press (runInstaller), and is checked again at that moment. */
      pendingInstaller = { file, sha256: expected, version: tag }
      return { phase: 'ready', version: tag }
    }
    if (asset.kind === 'app-zip') {
      flight.cleanup.push(file)
      const staging = `${paths.app}.partial-${crypto.randomBytes(4).toString('hex')}`
      flight.cleanup.push(staging)
      progress({ phase: 'unpack', received: 0, total: null }, true)
      await fsApi.mkdir(staging, { recursive: true, mode: 0o755 })
      await runChild('/usr/bin/ditto', ['-x', '-k', file, staging], signal)
      if (!exists(path.join(staging, 'Ollama.app', 'Contents', 'Resources', 'ollama'))) throw setupError('LOCAL_SETUP_ARCHIVE_INVALID', { reason: 'program' })
      await removeQuietly(paths.app)
      await fsApi.rename(staging, paths.app)
      await removeQuietly(file)
      await writeRecord({ version: tag, asset: asset.name, sha256: expected })
      return { phase: 'done', version: tag }
    }
    flight.cleanup.push(file)
    const staging = `${paths.program}.partial-${crypto.randomBytes(4).toString('hex')}`
    flight.cleanup.push(staging)
    await fsApi.mkdir(staging, { recursive: true, mode: 0o755 })
    const size = (await fsApi.stat(file)).size
    let read = 0
    const source = fsSync.createReadStream(file)
    source.on('data', chunk => { read += chunk.length; progress({ phase: 'unpack', received: read, total: size }) })
    const decompress = zlib.createZstdDecompress({ params: { [zlib.constants.ZSTD_d_windowLogMax]: 31 } })
    const stream = pipeline(source, decompress, () => {})
    const stopUnpacking = () => source.destroy(setupError('LOCAL_SETUP_CANCELLED'))
    signal.addEventListener('abort', stopUnpacking, { once: true })
    progress({ phase: 'unpack', received: 0, total: size }, true)
    try {
      await extractTar(stream, staging, { fsApi, signal })
    } catch (error) {
      if (signal.aborted) throw setupError('LOCAL_SETUP_CANCELLED')
      if (error?.code === 'ENOSPC') throw setupError('LOCAL_SETUP_DISK_FULL', { needBytes: need, freeBytes: statDisk(paths.root) })
      if (error?.code && String(error.code).startsWith('LOCAL_SETUP_')) throw error
      throw setupError('LOCAL_SETUP_ARCHIVE_INVALID', { reason: error?.code || 'read' })
    } finally {
      signal.removeEventListener('abort', stopUnpacking)
      source.destroy()
      decompress.destroy()
    }
    const binary = path.join(staging, 'bin', exe)
    if (!exists(binary)) throw setupError('LOCAL_SETUP_ARCHIVE_INVALID', { reason: 'program' })
    await removeQuietly(paths.program)
    await fsApi.rename(staging, paths.program)
    await removeQuietly(file)
    await writeRecord({ version: tag, asset: asset.name, sha256: expected })
    return { phase: 'done', version: tag }
  }

  async function writeRecord(record) {
    const text = `${JSON.stringify({ ...record, installedAt: new Date(now()).toISOString() }, null, 2)}\n`
    await fsApi.writeFile(path.join(paths.root, 'install.json'), text, { mode: 0o600 })
  }

  function runChild(command, args, signal) {
    return new Promise((resolve, reject) => {
      let child
      try { child = spawnInstaller(command, args, { stdio: 'ignore', windowsHide: true }) } catch { reject(setupError('LOCAL_SETUP_ARCHIVE_INVALID', { reason: 'unpack' })); return }
      const abort = () => { try { child.kill() } catch { /* gone */ } }
      signal?.addEventListener('abort', abort, { once: true })
      child.once('error', () => { signal?.removeEventListener('abort', abort); reject(setupError('LOCAL_SETUP_ARCHIVE_INVALID', { reason: 'unpack' })) })
      child.once('exit', code => {
        signal?.removeEventListener('abort', abort)
        if (signal?.aborted) reject(setupError('LOCAL_SETUP_CANCELLED'))
        else if (code === 0) resolve()
        else reject(setupError('LOCAL_SETUP_ARCHIVE_INVALID', { reason: 'unpack' }))
      })
    })
  }

  function install(emit = () => {}) {
    const asset = releaseAsset(platform, arch)
    if (!asset) return refusal('LOCAL_SETUP_PLATFORM_UNSUPPORTED', { platform, arch })
    if (installFlight) return refusal('LOCAL_SETUP_BUSY')
    const controller = new AbortController()
    const flight = { asset, controller, cleanup: [], progress: { phase: 'release', received: 0, total: null }, report: throttle(emit) }
    installFlight = flight
    lastInstall = null
    flight.done = runInstall(flight).then(result => {
      lastInstall = { ...flight.progress, ...result, code: null }
      if (installFlight === flight) installFlight = null
      flight.report({ kind: 'install', ...pick(lastInstall, INSTALL_FIELDS) }, true)
    }, async error => {
      for (const entry of flight.cleanup) await removeQuietly(entry)
      const code = controller.signal.aborted ? 'LOCAL_SETUP_CANCELLED'
        : typeof error?.code === 'string' && error.code.startsWith('LOCAL_SETUP_') ? error.code : 'LOCAL_SETUP_NETWORK'
      lastInstall = { ...flight.progress, phase: code === 'LOCAL_SETUP_CANCELLED' ? 'cancelled' : 'failed', code, ...pick(error?.details || {}, ['needBytes', 'freeBytes']) }
      if (installFlight === flight) installFlight = null
      flight.report({ kind: 'install', ...pick(lastInstall, INSTALL_FIELDS) }, true)
    })
    return { ok: true, started: true, asset: asset.name }
  }

  function cancelInstall() {
    if (!installFlight) return { ok: true, cancelled: false }
    installFlight.controller.abort()
    return { ok: true, cancelled: true }
  }

  /* THE INSTALLER'S WINDOW IS WHAT THE PERSON PRESSED FOR. Ollama's Windows
     installer is a setup wizard they click through. windowsHide: true starts a
     program with SW_HIDE, which its first window obeys, so the wizard could
     never appear. Named rather than written as a plain false, defined false
     here only, and used by this one launch:
     tools/test/console-window-fence.test.mjs counts all three. */
  const INSTALLER_WINDOW_IS_THE_POINT = false

  /* WINDOWS: THE VERIFIED INSTALLER, ONLY ON THE PERSON'S PRESS. Its sum is
     taken again first, so a file changed on disk since the download is
     refused, not run. The installer is Ollama's own per-user one: it asks for
     no administrator rights. */
  async function runInstaller(emit = () => {}) {
    if (platform !== 'win32') return refusal('LOCAL_SETUP_PLATFORM_UNSUPPORTED', { platform, arch })
    if (installerFlight) return refusal('LOCAL_SETUP_BUSY')
    const pending = pendingInstaller
    if (!pending || !exists(pending.file)) return refusal('LOCAL_SETUP_INSTALLER_MISSING')
    let actual
    try { actual = await sha256Of(pending.file) } catch { return refusal('LOCAL_SETUP_INSTALLER_MISSING') }
    if (actual !== pending.sha256) {
      await removeQuietly(pending.file)
      pendingInstaller = null
      lastInstall = null
      return refusal('LOCAL_SETUP_CHECKSUM_MISMATCH')
    }
    let child
    try {
      child = spawnInstaller(pending.file, [], { detached: true, stdio: 'ignore', windowsHide: INSTALLER_WINDOW_IS_THE_POINT })
    } catch {
      return refusal('LOCAL_SETUP_INSTALLER_FAILED')
    }
    installerFlight = { child }
    const report = throttle(emit)
    child.once('error', () => {
      installerFlight = null
      report({ kind: 'installer', phase: 'failed', code: 'LOCAL_SETUP_INSTALLER_FAILED' }, true)
    })
    child.once('exit', async code => {
      installerFlight = null
      if (code === 0) {
        await removeQuietly(pending.file)
        if (pendingInstaller === pending) pendingInstaller = null
        lastInstall = { phase: 'done', version: pending.version, code: null }
      }
      report({ kind: 'installer', phase: code === 0 ? 'done' : 'failed', code: code === 0 ? null : 'LOCAL_SETUP_INSTALLER_FAILED' }, true)
    })
    return { ok: true, started: true }
  }

  /* ------------------------------------------------------- serving -- */

  function serveEnvironment(found, address) {
    const variables = { ...env, OLLAMA_HOST: hostVariable(address) }
    if (found.appCopy) {
      /* This app's copy keeps everything it writes in this app's folder:
         its models, and the key file Ollama makes in its home folder. */
      variables.OLLAMA_MODELS = paths.models
      if (platform === 'win32') variables.USERPROFILE = paths.home
      else variables.HOME = paths.home
    }
    return variables
  }

  async function waitForAnswer(address, child, deadline) {
    while (now() < deadline) {
      if (child.exited) return false
      const answer = await probe(address)
      if (answer.answering === 'yes') return true
      await new Promise(resolve => timers.setTimeout(resolve, 250))
    }
    return false
  }

  async function start() {
    const settings = settingsNow()
    const address = localAddress(settings.values['model.endpoint'])
    if (!address.usable) return refusal('LOCAL_SETUP_ADDRESS_UNUSABLE', { address: address.url })
    if (!address.local) return refusal('LOCAL_SETUP_ADDRESS_REMOTE', { address: address.url })
    const before = await probe(address)
    if (before.answering === 'yes') return { ok: true, running: true, already: true }
    if (serve && !serve.exited) return refusal('LOCAL_SETUP_BUSY')
    const found = program()
    if (!found) return refusal('LOCAL_SETUP_NOT_INSTALLED')
    /* In the product's isolated test mode every home lives inside one test
       folder; a program outside this app's own copy is not started there. */
    if (isolated && !found.appCopy) return refusal('LOCAL_SETUP_ISOLATED')
    if (typeof spawnServe !== 'function') return refusal('LOCAL_SETUP_ENGINE_UNAVAILABLE')
    try {
      await fsApi.mkdir(paths.logs, { recursive: true, mode: 0o700 })
      if (found.appCopy) {
        await fsApi.mkdir(paths.models, { recursive: true, mode: 0o700 })
        await fsApi.mkdir(paths.home, { recursive: true, mode: 0o700 })
      }
    } catch { return refusal('LOCAL_SETUP_START_FAILED') }
    let child
    try {
      child = spawnServe(found.file, ['serve'], {
        env: serveEnvironment(found, address),
        cwd: found.appCopy ? paths.root : path.dirname(found.file),
        stdio: ['ignore', 'pipe', 'pipe'],
        containProcessTree: true,
      })
    } catch {
      return refusal('LOCAL_SETUP_START_FAILED')
    }
    const record = { child, address: address.url, file: found.file, exited: false, lines: [], log: null }
    serveLogProblem = null
    /* THE LOG IS KEPT, NOT REQUIRED. A log file that cannot be opened or
       written (a full disk, a folder without permission) reports that on the
       stream's 'error' event, after write() has returned; unheard, that event
       is thrown in the main process. It is taken here: the log stops, Ollama
       carries on, the last lines stay in memory for a failed start's reason,
       and status() says the log is not being saved. */
    const logFailed = error => {
      /* A late error from the log of an Ollama that has since been replaced
         by a newer start is not the newer one's problem. */
      if (!serve || serve === record) {
        serveLogProblem = error?.code === 'ENOSPC' || error?.code === 'EDQUOT' ? 'LOCAL_SETUP_LOG_DISK_FULL' : 'LOCAL_SETUP_LOG_WRITE_FAILED'
      }
      const log = record.log
      record.log = null
      try { log?.destroy() } catch { /* already closed */ }
    }
    try {
      record.log = fsSync.createWriteStream(path.join(paths.logs, 'ollama-serve.log'), { flags: 'a', mode: 0o600 })
      record.log.on('error', logFailed)
    } catch (error) { logFailed(error) }
    const keep = data => {
      const text = String(data)
      record.log?.write(text)
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        record.lines.push(line.slice(0, 400))
        if (record.lines.length > 40) record.lines.shift()
      }
    }
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    child.once('exit', code => {
      record.exited = true
      record.exitCode = code
      try { record.log?.end() } catch { /* closing a log */ }
      if (serve === record) serve = null
    })
    child.once('error', () => { record.exited = true; if (serve === record) serve = null })
    serve = record
    const answered = await waitForAnswer(address, record, now() + START_WAIT_MS)
    if (!answered) {
      const inUse = record.lines.some(line => /address already in use|bind: /i.test(line))
      await stop()
      /* Ollama's own last error line rides back so the popup can say what it
         said; this app's folders are named in words, not paths. */
      const said = [...record.lines].reverse().find(line => /error|panic|fatal|failed|denied|cannot|could not/i.test(line)) || ''
      const detail = said.split(paths.root).join('the ToolsEnabled folder').split(home || '\0').join('your home folder').slice(0, 200)
      return refusal(inUse ? 'LOCAL_SETUP_PORT_IN_USE' : 'LOCAL_SETUP_START_FAILED', { address: address.url, ...(detail ? { detail } : {}) })
    }
    return { ok: true, running: true, startedHere: true, address: address.url }
  }

  async function stop() {
    const record = serve
    if (!record || record.exited) return { ok: true, stopped: false }
    const child = record.child
    const exited = new Promise(resolve => {
      if (record.exited) resolve()
      else child.once('exit', resolve)
    })
    try {
      if (typeof child.terminateJob === 'function') await Promise.resolve(child.terminateJob()).catch(() => {})
      else child.kill(platform === 'win32' ? undefined : 'SIGTERM')
    } catch { /* already gone */ }
    let timer
    const settled = await Promise.race([exited.then(() => true), new Promise(resolve => { timer = timers.setTimeout(() => resolve(false), STOP_WAIT_MS) })])
    timers.clearTimeout(timer)
    if (!settled) {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }
    if (serve === record) serve = null
    return { ok: true, stopped: true }
  }

  /* ------------------------------------------------------- the pull -- */

  function pullError(message) {
    const text = String(message || '')
    if (/no space left|not enough (disk )?space|disk (is )?full|insufficient (disk )?space/i.test(text)) return 'LOCAL_SETUP_PULL_DISK_FULL'
    if (/file does not exist|manifest unknown|not found|does not exist/i.test(text)) return 'LOCAL_SETUP_PULL_UNKNOWN_MODEL'
    if (/timeout|timed out|connection (reset|refused)|no such host|network|dial tcp|EOF/i.test(text)) return 'LOCAL_SETUP_PULL_NETWORK'
    return 'LOCAL_SETUP_PULL_FAILED'
  }

  async function pull({ model } = {}, emit = () => {}) {
    if (typeof model !== 'string' || !MODEL_ID_RE.test(model)) return refusal('LOCAL_SETUP_MODEL_INVALID')
    if (pullFlight) return refusal('LOCAL_SETUP_BUSY')
    const settings = settingsNow()
    const address = localAddress(settings.values['model.endpoint'])
    if (!address.usable) return refusal('LOCAL_SETUP_ADDRESS_UNUSABLE', { address: address.url })
    const answer = await probe(address)
    if (answer.answering !== 'yes') return refusal('LOCAL_SETUP_NOT_RUNNING', { address: address.url })
    /* Isolated test mode never asks an Ollama it did not start to change its
       own model store. */
    if (isolated && !(serve && !serve.exited && serve.address === address.url)) return refusal('LOCAL_SETUP_ISOLATED')
    const entry = curated().find(row => row.id === model) || null
    const size = entry && Number.isFinite(entry.downloadBytes) ? entry.downloadBytes : null
    const folder = modelsFolder(program())
    const free = address.local ? statDisk(folder) : null
    const need = size ? Math.ceil(size * 1.05) + 256 * MiB : null
    if (need && Number.isFinite(free) && free < need) return refusal('LOCAL_SETUP_DISK_FULL', { needBytes: need, freeBytes: free, model })
    const report = throttle(emit)
    const flight = { model, request: null, cancelled: false, progress: { model, phase: 'progress', completed: 0, total: size, status: 'starting' }, parts: new Map() }
    pullFlight = flight
    lastPull = null
    const finish = (phase, code = null, detail = null) => {
      if (pullFlight !== flight) return
      pullFlight = null
      lastPull = { ...flight.progress, phase, code, ...(detail ? { detail: String(detail).slice(0, 300) } : {}) }
      report({ kind: 'pull', ...pick(lastPull, PULL_FIELDS) }, true)
    }
    const body = Buffer.from(JSON.stringify({ model, stream: true }))
    let stall = null
    const armStall = () => {
      timers.clearTimeout(stall)
      stall = timers.setTimeout(() => { flight.stalled = true; flight.request?.destroy() }, PULL_STALL_MS)
    }
    try {
      flight.request = httpImpl.request({
        host: address.host, port: address.port, path: '/api/pull', method: 'POST', family: address.host.includes(':') ? 6 : 4, agent: false,
        headers: { 'content-type': 'application/json', 'content-length': String(body.length), accept: 'application/x-ndjson' },
      }, response => {
        armStall()
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const parts = []
          response.on('data', chunk => { if (parts.reduce((n, c) => n + c.length, 0) < MAX_PULL_LINE_BYTES) parts.push(chunk) })
          response.on('end', () => {
            timers.clearTimeout(stall)
            let message = Buffer.concat(parts).toString('utf8')
            try { message = JSON.parse(message).error || message } catch { /* plain text */ }
            finish('failed', pullError(message), message)
          })
          return
        }
        let pending = ''
        let failure = null
        let succeeded = false
        response.setEncoding('utf8')
        response.on('data', text => {
          armStall()
          pending += text
          if (pending.length > MAX_PULL_LINE_BYTES * 4) { failure = { code: 'LOCAL_SETUP_PULL_FAILED', detail: null }; response.destroy(); return }
          let newline
          while ((newline = pending.indexOf('\n')) !== -1) {
            const line = pending.slice(0, newline).trim()
            pending = pending.slice(newline + 1)
            if (!line) continue
            let packet
            try { packet = JSON.parse(line) } catch { continue }
            if (packet && typeof packet.error === 'string') {
              failure = { code: pullError(packet.error), detail: packet.error }
              continue
            }
            if (packet && typeof packet.digest === 'string' && Number.isFinite(packet.total)) {
              flight.parts.set(packet.digest, { total: packet.total, completed: Number.isFinite(packet.completed) ? packet.completed : 0 })
            }
            if (packet && packet.status === 'success') succeeded = true
            let completed = 0
            let total = 0
            for (const part of flight.parts.values()) { completed += part.completed; total += part.total }
            flight.progress = { ...flight.progress, status: typeof packet?.status === 'string' ? packet.status.slice(0, 80) : flight.progress.status,
              completed, total: total || flight.progress.total }
            report({ kind: 'pull', ...pick(flight.progress, PULL_FIELDS) })
          }
        })
        response.on('end', () => {
          timers.clearTimeout(stall)
          if (flight.cancelled) return finish('cancelled', 'LOCAL_SETUP_CANCELLED')
          if (failure) return finish('failed', failure.code, failure.detail)
          if (!succeeded) return finish('failed', flight.stalled ? 'LOCAL_SETUP_PULL_NETWORK' : 'LOCAL_SETUP_PULL_FAILED')
          finish('done')
        })
        response.on('error', () => {
          timers.clearTimeout(stall)
          if (flight.cancelled) return finish('cancelled', 'LOCAL_SETUP_CANCELLED')
          finish('failed', flight.stalled ? 'LOCAL_SETUP_PULL_NETWORK' : 'LOCAL_SETUP_PULL_FAILED')
        })
        response.on('aborted', () => {
          timers.clearTimeout(stall)
          if (flight.cancelled) return finish('cancelled', 'LOCAL_SETUP_CANCELLED')
          finish('failed', flight.stalled ? 'LOCAL_SETUP_PULL_NETWORK' : 'LOCAL_SETUP_PULL_FAILED')
        })
      })
    } catch {
      pullFlight = null
      return refusal('LOCAL_SETUP_NOT_RUNNING', { address: address.url })
    }
    flight.request.on('error', () => {
      timers.clearTimeout(stall)
      if (flight.cancelled) return finish('cancelled', 'LOCAL_SETUP_CANCELLED')
      finish('failed', flight.stalled ? 'LOCAL_SETUP_PULL_NETWORK' : 'LOCAL_SETUP_NOT_RUNNING')
    })
    flight.request.on('close', () => {
      timers.clearTimeout(stall)
      if (flight.cancelled) finish('cancelled', 'LOCAL_SETUP_CANCELLED')
    })
    flight.request.end(body)
    armStall()
    report({ kind: 'pull', ...pick(flight.progress, PULL_FIELDS) }, true)
    return { ok: true, started: true, model, diskChecked: Boolean(need && Number.isFinite(free)) }
  }

  /* Ollama stops a pull when the request that asked for it goes away, and
     keeps what it already has so the next pull of the same model resumes. */
  function cancelPull() {
    const flight = pullFlight
    if (!flight) return { ok: true, cancelled: false }
    flight.cancelled = true
    try { flight.request?.destroy() } catch { /* already closed */ }
    return { ok: true, cancelled: true }
  }

  async function check() {
    const answer = await readiness()
    return { ok: true, ...answer }
  }

  function stopAll() {
    if (installFlight) installFlight.controller.abort()
    if (pullFlight) cancelPull()
    if (serve && !serve.exited) {
      try {
        if (typeof serve.child.terminateJob === 'function') serve.child.terminateJob()
        else serve.child.kill()
      } catch { /* already gone */ }
    }
  }

  return Object.freeze({
    paths,
    status,
    install,
    cancelInstall,
    runInstaller,
    start,
    stop,
    pull,
    cancelPull,
    check,
    stopAll,
    fitFor,
    settled: () => Promise.all([installFlight?.done].filter(Boolean)),
  })
}

module.exports = {
  DEFAULT_ADDRESS,
  OFFICIAL_RELEASES,
  createLocalModelSetup,
  extractTar,
  localAddress,
  parseChecksums,
  releaseAsset,
  safeArchivePath,
}
