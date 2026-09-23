#!/usr/bin/env node
// Actual packaged ELF, unchanged production fuses, fresh homes, renderer CDP.
// This is first-run acceptance, not completed onboarding or provider sign-in.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveCapabilitySourceBinding, assertCapabilitySourceGitBinding } from './lib/capability-source-git.mjs'
import { INSTALL_ROOT, verifyExternalManifest, verifyInstalledTree } from './lib/linux-installed-manifest.mjs'

const require = createRequire(import.meta.url)
const { sterileLaunchEnvironment, sterileProfileDirectories, prepareSterileProfile } = require('./lib/sterile-launch.cjs')
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const codeError = code => Object.assign(new Error(code), { code })
const check = (condition, code) => { if (!condition) throw codeError(code) }
const within = (child, root) => { const relative = path.relative(root, child); return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative) }

export function parseOptions(argv) {
  const options = { evidenceDir: path.join(ROOT, 'artifacts'), timeoutMs: 90000, proofMode: 'unpacked' }
  const names = new Map([['--artifact', 'artifact'], ['--evidence-dir', 'evidenceDir'],
    ['--expected-app-ref', 'appRef'], ['--expected-engine-ref', 'engineRef'], ['--engine-source', 'engineSource'],
    ['--app-source', 'appSource'], ['--timeout-ms', 'timeoutMs'], ['--proof-mode', 'proofMode'],
    ['--deb', 'deb'], ['--expected-package-sha256', 'packageSha256'],
    ['--installed-manifest', 'manifestFile'], ['--expected-manifest-sha256', 'manifestSha256']])
  const seen = new Set()
  for (let index = 0; index < argv.length; index += 2) {
    const key = names.get(argv[index]), value = argv[index + 1]
    check(key && value && !value.startsWith('--') && !seen.has(key), 'SEALED_OPTIONS_INVALID')
    seen.add(key); options[key] = value
  }
  check(typeof options.artifact === 'string', 'SEALED_ARTIFACT_REQUIRED')
  check(typeof options.appSource === 'string' && options.appSource.trim(), 'SEALED_APP_SOURCE_REQUIRED')
  check(typeof options.engineSource === 'string' && options.engineSource.trim(), 'SEALED_ENGINE_SOURCE_REQUIRED')
  check([options.appRef, options.engineRef].every(value => /^[a-f0-9]{40}$/.test(value || '')), 'SEALED_EXACT_REFS_REQUIRED')
  options.artifact = path.resolve(options.artifact)
  options.appSource = path.resolve(options.appSource)
  options.engineSource = path.resolve(options.engineSource)
  options.evidenceDir = path.resolve(options.evidenceDir)
  options.timeoutMs = Number(options.timeoutMs)
  check(Number.isSafeInteger(options.timeoutMs) && options.timeoutMs >= 1000 && options.timeoutMs <= 180000, 'SEALED_TIMEOUT_INVALID')
  check(!within(options.evidenceDir, options.artifact) && options.evidenceDir !== options.artifact, 'SEALED_EVIDENCE_INSIDE_ARTIFACT')
  check(['unpacked', 'installed'].includes(options.proofMode), 'SEALED_PROOF_MODE_INVALID')
  const installedKeys = ['deb', 'packageSha256', 'manifestFile', 'manifestSha256']
  if (options.proofMode === 'installed') {
    check(options.artifact === INSTALL_ROOT, 'SEALED_INSTALLED_ROOT_REQUIRED')
    check(installedKeys.every(key => typeof options[key] === 'string'), 'SEALED_INSTALLED_BINDING_REQUIRED')
    check([options.packageSha256, options.manifestSha256].every(value => /^[a-f0-9]{64}$/.test(value)), 'SEALED_INSTALLED_DIGEST_REQUIRED')
    for (const key of ['deb', 'manifestFile']) {
      options[key] = path.resolve(options[key])
      check(!within(options[key], INSTALL_ROOT) && options[key] !== INSTALL_ROOT, 'SEALED_BINDING_INSIDE_INSTALL')
    }
  } else check(installedKeys.every(key => options[key] === undefined), 'SEALED_INSTALLED_OPTIONS_IN_UNPACKED_MODE')
  return Object.freeze(options)
}

export async function installedPhase(options, phase, operations = { verifyExternalManifest, verifyInstalledTree }) {
  check(options.proofMode === 'installed' && options.artifact === INSTALL_ROOT && ['before', 'after'].includes(phase), 'SEALED_INSTALLED_PHASE_INVALID')
  const manifest = await operations.verifyExternalManifest(options)
  const proof = await operations.verifyInstalledTree(manifest)
  check(proof?.installedTreeMatches === true && proof?.readonlyObserved === true && proof?.profileMatches === true, 'SEALED_INSTALLED_PROOF_INCOMPLETE')
  return { manifest, receipt: { phase, ...proof, packageSha256: options.packageSha256, manifestSha256: options.manifestSha256 } }
}

export function assertInstalledRuntime(runtime, manifest, build, label, restricted) {
  check(runtime?.isPackaged === true && runtime.execPath === INSTALL_ROOT + '/toolsenabled'
    && runtime.resourcesPath === INSTALL_ROOT + '/resources' && runtime.appPath === INSTALL_ROOT + '/resources/app.asar'
    && runtime.version === manifest.package.version && build.appRef === manifest.source.appRef
    && build.engineRef === manifest.source.engineRef
    && build.executableSha256 === manifest.entries.find(item => item.path === 'toolsenabled')?.sha256, 'SEALED_INSTALLED_RUNTIME_MISMATCH')
  check(typeof restricted === 'boolean' && typeof label === 'string' && label.length <= 256, 'SEALED_APPARMOR_STATE_UNKNOWN')
  if (restricted) check(label.trim() === 'toolsenabled-customer (unconfined)', 'SEALED_APPARMOR_ATTACHMENT_MISMATCH')
  return { fixedInstalledRuntime: true, usernsRestriction: restricted, appArmorAttachment: restricted ? 'toolsenabled-customer' : 'not-required' }
}

function installedAppArmorState(pid) {
  let value = '0'
  try { value = fs.readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').trim() }
  catch (error) { if (error.code !== 'ENOENT') throw codeError('SEALED_APPARMOR_STATE_UNKNOWN') }
  check(['0', '1'].includes(value), 'SEALED_APPARMOR_STATE_UNKNOWN')
  // Exact owned process attachment proves loaded policy without requiring an
  // ordinary user to read the root-only system-wide loaded-profile inventory.
  let label = ''
  try { label = fs.readFileSync(`/proc/${pid}/attr/current`, 'utf8') }
  catch (error) { if (value === '1' || error.code !== 'ENOENT') throw codeError('SEALED_APPARMOR_STATE_UNKNOWN') }
  return { label, restricted: value === '1' }
}

export function launchEnvironment(profile, base = process.env) {
  // Session connection metadata only. No inherited API keys, provider homes,
  // Docker endpoint/context override, loader hooks, service roots or MC flags.
  const allowed = { LANG: 'C.UTF-8' }
  for (const key of ['DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_SESSION_TYPE',
    'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_CURRENT_DESKTOP',
    'XDG_SESSION_DESKTOP', 'DESKTOP_SESSION']) if (typeof base[key] === 'string') allowed[key] = base[key]
  return sterileLaunchEnvironment(profile, allowed, { systemPathOnly: true, platform: 'linux' })
}

export function launchArguments(userData) {
  check(path.isAbsolute(userData), 'SEALED_PROFILE_INVALID')
  return [`--user-data-dir=${userData}`, '--remote-debugging-port=0']
}

export function assertShortTempBudget(directory) {
  // Linux sockaddr_un.sun_path is108 bytes including NUL. Reserve80 bytes for
  // Chromium's generated singleton directory/socket suffix, not just today's
  // observed basename. Never inherit an arbitrary owner TMPDIR.
  check(path.isAbsolute(directory) && Buffer.byteLength(directory, 'utf8') + 80 <= 107, 'SEALED_UNIX_SOCKET_PATH_TOO_LONG')
}

export function createShortLaunchTemp() {
  check(process.platform === 'linux' && fs.realpathSync('/tmp') === '/tmp', 'SEALED_SHORT_TEMP_ROOT_INVALID')
  const directory = fs.mkdtempSync('/tmp/te-sealed-')
  const stat = fs.lstatSync(directory)
  check(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid()
    && !(stat.mode & 0o077), 'SEALED_SHORT_TEMP_UNSAFE')
  assertShortTempBudget(directory)
  return Object.freeze({ directory, dev: stat.dev, ino: stat.ino })
}

export function releaseShortLaunchTemp(receipt, { childTerminal, remainingPids = [], gateCleanupUnprovenPids = [] }) {
  check(/^\/tmp\/te-sealed-[A-Za-z0-9]{6}$/.test(receipt.directory), 'SEALED_SHORT_TEMP_IDENTITY_INVALID')
  if (!childTerminal || remainingPids.length || gateCleanupUnprovenPids.length) return { path: receipt.directory, removed: false, reason: 'cleanup-unproven' }
  const stat = fs.lstatSync(receipt.directory)
  check(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && !(stat.mode & 0o077)
    && stat.dev === receipt.dev && stat.ino === receipt.ino, 'SEALED_SHORT_TEMP_IDENTITY_CHANGED')
  // Do not recursively delete diagnostic files or a Chromium socket subtree.
  // Empty and terminal means removable; nonempty stays as private evidence.
  try { fs.rmdirSync(receipt.directory); return { path: receipt.directory, removed: true } }
  catch (error) {
    if (error.code === 'ENOTEMPTY' || error.code === 'EEXIST') return { path: receipt.directory, removed: false, reason: 'nonempty-evidence-retained' }
    throw error
  }
}

export function gateEnvironment(script, env, options) {
  if (script !== 'check-payload-current.mjs') return env
  check(typeof options.engineSource === 'string' && options.engineSource.trim(), 'SEALED_ENGINE_SOURCE_REQUIRED')
  check(/^[a-f0-9]{40}$/.test(options.engineRef || ''), 'SEALED_EXACT_REFS_REQUIRED')
  // Explicit clean source provenance belongs only to this read-only gate.
  // Never mutate the sterile environment later passed to the native GUI.
  const binding = resolveCapabilitySourceBinding({ repoRoot: options.appSource,
    explicitSource: options.engineSource, explicitSourceRef: options.engineRef, environment: env })
  return { ...env, TOOLSENABLED_SOURCE: binding.source, TOOLSENABLED_SOURCE_REF: binding.sourceRef }
}

export function bindAppSource(options, env) {
  check(typeof options.appSource === 'string' && options.appSource.trim(), 'SEALED_APP_SOURCE_REQUIRED')
  const binding = assertCapabilitySourceGitBinding({ source: options.appSource, expectedRef: options.appRef, environment: env })
  // Generated dist is deliberately not treated as Git-authenticated: the real
  // ASAR and renderer gates compare/inspect it, including ignored build output.
  check(fs.statSync(path.join(binding.source, 'package.json')).isFile()
    && fs.statSync(path.join(binding.source, 'shell/main.cjs')).isFile(), 'SEALED_APP_SOURCE_LAYOUT')
  return binding.source
}

export function assertBuildMetadata(build, payload, options) {
  check(build?.schemaVersion === 2 && build.ref === options.appRef && build.app?.ref === options.appRef
    && build.dirty === false && build.overridden === false && build.app.dirty === false
    && Array.isArray(build.dirtyFiles) && build.dirtyFiles.length === 0
    && build.payload?.resolved === true && build.payload.ref === options.engineRef && build.payload.dirty === false
    && payload?.sourceRef === options.engineRef, 'SEALED_BUILD_REFS_MISMATCH')
}

export function assertFusePolicy(wire) {
  // @electron/fuses returns the on-disk ASCII wire values, not booleans.
  check(wire?.version === '1' && wire[0] === 49 && wire[2] === 48 && wire[3] === 48 && wire[5] === 49,
    'SEALED_FUSE_POLICY_MISMATCH')
  return { runAsNode: true, nodeOptionsEnvironment: false, nodeCliInspector: false, onlyLoadAppFromAsar: true }
}

export function processIdentity(pid) {
  check(Number.isSafeInteger(pid) && pid > 0, 'SEALED_PID_INVALID')
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)
    check(/^\d+$/.test(fields[19] || ''), 'SEALED_PROCESS_IDENTITY_INVALID')
    return { pid, start: fields[19] }
  } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return null; throw error }
}
const sameProcess = identity => identity && processIdentity(identity.pid)?.start === identity.start

export function validateDebugPort(text) {
  const lines = text.trim().split('\n')
  const port = Number(lines[0])
  check(lines.length === 2 && /^\d+$/.test(lines[0]) && Number.isSafeInteger(port) && port > 0 && port < 65536
    && /^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(lines[1]), 'SEALED_DEBUG_PORT_INVALID')
  return { port, browser: `ws://127.0.0.1:${port}${lines[1]}` }
}
export function validateLoopback(value) {
  let url
  try { url = new URL(value) } catch { throw codeError('SEALED_ENDPOINT_INVALID') }
  check(url.protocol === 'http:' && url.hostname === '127.0.0.1' && !!url.port
    && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'SEALED_ENDPOINT_INVALID')
  return url.origin
}

export function assertAttestation(value, { artifact, userData, pid, version, rendererUrl }) {
  check(value?.ok === true, 'SEALED_RUNTIME_ATTESTATION_UNAVAILABLE')
  check(value.isPackaged === true && value.platform === 'linux' && value.pid === pid, 'SEALED_RUNTIME_IDENTITY_MISMATCH')
  check(value.execPath === path.join(artifact, 'toolsenabled') && value.resourcesPath === path.join(artifact, 'resources')
    && value.appPath === path.join(artifact, 'resources', 'app.asar') && value.userData === userData
    && value.version === version, 'SEALED_RUNTIME_PATH_MISMATCH')
  check(value.noSandboxSwitch === false && value.window?.sandbox === true && value.window.contextIsolation === true
    && value.window.nodeIntegration === false, 'SEALED_SANDBOX_DISABLED')
  check(value.window.visible === true, 'SEALED_WINDOW_NOT_VISIBLE')
  const origin = validateLoopback(value.shellOrigin)
  check(new URL(value.window.url).origin === origin && value.window.url === rendererUrl, 'SEALED_RENDERER_BINDING_MISMATCH')
  return value
}

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const stat = fs.lstatSync(directory)
  check(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid()
    && !(stat.mode & 0o077) && fs.realpathSync(directory) === directory, 'SEALED_PRIVATE_DIRECTORY_INVALID')
}

function assertArtifact(artifact) {
  check(artifact !== path.parse(artifact).root && fs.realpathSync(artifact) === artifact, 'SEALED_ARTIFACT_PATH_INVALID')
  const rootStat = fs.lstatSync(artifact)
  check(rootStat.isDirectory() && [0, process.getuid()].includes(rootStat.uid) && !(rootStat.mode & 0o022), 'SEALED_ARTIFACT_WRITABLE_BY_OTHER')
  // Check the narrow artifact markers before walking anything. A mistyped
  // home/workspace path must not turn into a recursive profile inspection.
  for (const relative of ['toolsenabled', 'resources/app.asar', 'resources/capability/PAYLOAD.json']) {
    const stat = fs.lstatSync(path.join(artifact, relative))
    check(stat.isFile() && !stat.isSymbolicLink(), 'SEALED_ARTIFACT_LAYOUT_INVALID')
  }
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name), stat = fs.lstatSync(full)
      check(!stat.isSymbolicLink() && (stat.isFile() || stat.isDirectory()), 'SEALED_ARTIFACT_NONREGULAR')
      check([0, process.getuid()].includes(stat.uid) && !(stat.mode & 0o022), 'SEALED_ARTIFACT_WRITABLE_BY_OTHER')
      if (stat.isDirectory()) walk(full)
    }
  }
  walk(artifact)
  const executable = path.join(artifact, 'toolsenabled')
  const fd = fs.openSync(executable, 'r'), header = Buffer.alloc(4)
  try { fs.readSync(fd, header); check(header.equals(Buffer.from([127, 69, 76, 70])), 'SEALED_ELF_REQUIRED') }
  finally { fs.closeSync(fd) }
  return executable
}

export async function boundedGateChild(child, label, { timeoutMs = 240000, cleanupMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    let expired = false, cleanupTimer
    const timer = setTimeout(() => {
      expired = true
      child.kill('SIGTERM')
      cleanupTimer = setTimeout(() => {
        child.unref()
        const error = codeError(`SEALED_GATE_CLEANUP_UNPROVEN_${label.toUpperCase().replaceAll('-', '_')}`)
        error.ownedPid = child.pid
        reject(error)
      }, cleanupMs)
    }, timeoutMs)
    child.once('error', () => { clearTimeout(timer); clearTimeout(cleanupTimer); reject(codeError('SEALED_GATE_SPAWN_FAILED')) })
    child.once('exit', (status, signal) => { clearTimeout(timer); clearTimeout(cleanupTimer)
      if (status === 0 && !signal && !expired) resolve()
      else reject(codeError(`SEALED_GATE_REFUSED_${label.toUpperCase().replaceAll('-', '_')}`)) })
  })
}

async function gate(script, args, scratch, env, label, appSource) {
  const log = fs.openSync(path.join(scratch, `${label}.log`), 'wx', 0o600)
  try {
    const child = spawn(process.execPath, [path.join(appSource, 'tools', script), ...args],
      { cwd: appSource, env, stdio: ['ignore', log, log] })
    await boundedGateChild(child, label)
  } finally { fs.closeSync(log) }
}

async function connectCdp(url, timeoutMs) {
  const socket = new WebSocket(url)
  let nextId = 1
  const pending = new Map(), events = []
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(codeError('SEALED_CDP_TIMEOUT')) }, timeoutMs)
    socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    socket.addEventListener('error', () => { clearTimeout(timer); reject(codeError('SEALED_CDP_UNAVAILABLE')) }, { once: true })
  })
  const failPending = () => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(codeError('SEALED_CDP_DISCONNECTED')) } pending.clear() }
  socket.addEventListener('close', failPending)
  socket.addEventListener('error', failPending)
  socket.addEventListener('message', event => {
    if (typeof event.data !== 'string' || event.data.length > 24 * 1024 * 1024) { socket.close(); return }
    let packet
    try { packet = JSON.parse(event.data) } catch { socket.close(); return }
    const item = pending.get(packet.id)
    if (item) {
      pending.delete(packet.id); clearTimeout(item.timer)
      if (packet.error) item.reject(codeError('SEALED_CDP_COMMAND_FAILED'))
      else item.resolve(packet.result)
    } else if (packet.method === 'Runtime.exceptionThrown') {
      // Never retain exception text/object previews, which may carry secrets.
      if (events.length < 100) events.push({ type: 'pageerror', timestamp: packet.params?.timestamp ?? null })
    }
  })
  return {
    events,
    send(method, params = {}, timeout = 10000) {
      return new Promise((resolve, reject) => {
        const id = nextId++, timer = setTimeout(() => { pending.delete(id); reject(codeError('SEALED_CDP_COMMAND_TIMEOUT')) }, timeout)
        pending.set(id, { resolve, reject, timer })
        try { socket.send(JSON.stringify({ id, method, params })) }
        catch { clearTimeout(timer); pending.delete(id); reject(codeError('SEALED_CDP_DISCONNECTED')) }
      })
    },
    async evaluate(expression) {
      const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, 30000)
      check(!result.exceptionDetails, 'SEALED_RENDERER_EVALUATION_FAILED')
      return result.result?.value
    },
    close() { socket.close(); failPending() },
  }
}

async function readTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { redirect: 'error', signal: AbortSignal.timeout(3000) })
  check(response.ok, 'SEALED_CDP_TARGETS_UNAVAILABLE')
  const reader = response.body.getReader(), chunks = []
  let bytes = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes >= 1024 * 1024) { await reader.cancel(); throw codeError('SEALED_CDP_TARGETS_TOO_LARGE') }
      chunks.push(Buffer.from(value))
    }
  } finally { reader.releaseLock() }
  const text = Buffer.concat(chunks, bytes).toString('utf8')
  const targets = JSON.parse(text)
  check(Array.isArray(targets), 'SEALED_CDP_TARGETS_INVALID')
  const pages = targets.filter(entry => entry.type === 'page')
  check(pages.length === 1, 'SEALED_CDP_PAGE_AMBIGUOUS')
  const url = new URL(pages[0].webSocketDebuggerUrl)
  check(url.protocol === 'ws:' && url.hostname === '127.0.0.1' && Number(url.port) === port
    && !url.username && !url.password && !url.search && !url.hash
    && /^\/devtools\/page\/[a-zA-Z0-9-]+$/.test(url.pathname), 'SEALED_CDP_PAGE_ENDPOINT_INVALID')
  return { ...pages[0], webSocketDebuggerUrl: url.href }
}

async function ownerHostProof(capabilityRoot, stateRoot, expectedPid) {
  const authority = require(path.join(capabilityRoot, 'src/lib/owner-host-linux.js'))
  const file = path.join(stateRoot, 'state/owner-host-capability.json')
  const route = authority.readPrivateRecord(file)
  check(route && Object.keys(route).sort().join(',') === 'generation,pipeName,version'
    && route.version === 2 && authority.validEndpoint(route.pipeName, route.generation), 'SEALED_OWNER_ROUTE_INVALID')
  authority.assertSocket(route.pipeName)
  const socket = new net.Socket()
  try {
    await new Promise((resolve, reject) => {
      socket.setTimeout(3000, () => { socket.destroy(); reject(codeError('SEALED_OWNER_SOCKET_TIMEOUT')) })
      socket.once('error', () => reject(codeError('SEALED_OWNER_SOCKET_UNAVAILABLE')))
      socket.connect(route.pipeName, resolve)
    })
    const peer = await authority.assertPeer(socket, process.getuid())
    check(peer.pid === expectedPid, 'SEALED_OWNER_PEER_MISMATCH')
    assert.deepEqual(authority.readPrivateRecord(file), route)
    return { public: { ok: true, pid: peer.pid, uid: peer.uid, credentialSent: false }, route }
  } finally { socket.destroy() }
}

export async function ownerSocketClosed(route, { timeoutMs = 3000 } = {}) {
  if (!route?.pipeName) throw codeError('SEALED_OWNER_SHUTDOWN_UNPROVEN')
  return new Promise((resolve, reject) => {
    const socket = new net.Socket()
    const timer = setTimeout(() => { socket.destroy(); reject(codeError('SEALED_OWNER_SHUTDOWN_UNPROVEN')) }, timeoutMs)
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); reject(codeError('SEALED_OWNER_SOCKET_STILL_LISTENING')) })
    socket.once('error', error => {
      clearTimeout(timer); socket.destroy()
      if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) resolve({ listenerClosed: true, observation: error.code })
      else reject(codeError('SEALED_OWNER_SHUTDOWN_UNPROVEN'))
    })
    socket.connect(route.pipeName)
  })
}

// Serialized verbatim into the isolated renderer. No credentials escape the
// function; every HTTP/body operation has its own deadline and byte ceiling.
export async function rendererApiProbe() {
  async function request(url, init = {}, statusOnly = false) {
    const controller = new AbortController()
    let reader, onAbort
    const aborted = new Promise((resolve, reject) => {
      onAbort = () => {
        try { if (reader) Promise.resolve(reader.cancel()).catch(() => {}) } catch {}
        reject(new Error('bounded-request-refused'))
      }
      controller.signal.addEventListener('abort', onAbort, { once: true })
    })
    const timer = setTimeout(() => controller.abort(), 5000)
    try {
      return await Promise.race([(async () => {
        const response = await fetch(url, { ...init, cache: 'no-store', redirect: 'error', signal: controller.signal })
        if (controller.signal.aborted || statusOnly) {
          try { if (response.body) Promise.resolve(response.body.cancel()).catch(() => {}) } catch {}
          if (controller.signal.aborted) throw new Error('bounded-request-refused')
          return { status: response.status, body: null }
        }
        if (!response.body?.getReader) throw new Error('bounded-request-refused')
        reader = response.body.getReader()
        let bytes = 0
        const chunks = []
        for (;;) {
          const item = await reader.read()
          if (controller.signal.aborted) throw new Error('bounded-request-refused')
          if (item.done) break
          bytes += item.value.byteLength
          if (bytes > 1024 * 1024) { controller.abort(); throw new Error('bounded-request-refused') }
          chunks.push(item.value)
        }
        const buffer = new Uint8Array(bytes)
        let offset = 0
        for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength }
        return { status: response.status, body: JSON.parse(new TextDecoder().decode(buffer)) }
      })(), aborted])
    } finally {
      clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort)
      try { reader?.releaseLock() } catch {}
    }
  }
  try {
    const endpoint = await window.mcShell.getBridgeEndpoint()
    if (endpoint?.ok !== true) return { ok: false, stage: 'endpoint' }
    const origin = new URL(endpoint.baseUrl)
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port || origin.username
        || origin.password || origin.search || origin.hash || origin.pathname !== '/') return { ok: false, stage: 'endpoint-binding' }
    const unauthorized = await request(new URL('/v1/contract', origin), {}, true)
    if (![401, 403].includes(unauthorized.status)) return { ok: false, stage: 'unauthorized', status: unauthorized.status }
    const proof = await window.mcShell.getBridgeProof()
    if (proof?.ok !== true || typeof proof.proof !== 'string') return { ok: false, stage: 'proof' }
    const url = new URL('/v1/bootstrap', origin); url.searchParams.set('proof', proof.proof)
    const boot = await request(url), session = boot.body
    if (boot.status < 200 || boot.status >= 300 || session?.ok !== true || typeof session.token !== 'string') return { ok: false, stage: 'bootstrap' }
    const response = await request(new URL('/v1/contract', origin), { headers: { authorization: 'Bearer ' + session.token } })
    const contract = response.body
    if (response.status !== 200 || contract?.ok !== true || !Array.isArray(contract.contract?.actions)) return { ok: false, stage: 'contract' }
    return { ok: true, origin: origin.origin, unauthorizedStatus: unauthorized.status, contract: contract.contract }
  } catch { return { ok: false, stage: 'bounded-request' } }
}

export function rendererSetupReadiness() {
  // The router's .view.enter starts at opacity0 and transitions over --dur-3
  // (currently420ms). Rectangles/visibility alone can certify an invisible UI.
  const visible = element => {
    if (!element || !element.getClientRects().length) return false
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.right <= 0
        || rect.top >= innerHeight || rect.left >= innerWidth) return false
    let opacity = 1
    for (let cursor = element; cursor; cursor = cursor.parentElement) {
      const style = getComputedStyle(cursor), ownOpacity = Number(style.opacity)
      if (style.display === 'none' || style.visibility !== 'visible' || !Number.isFinite(ownOpacity)) return false
      opacity *= ownOpacity
      if (opacity < 0.98) return false
      for (const animation of cursor.getAnimations?.() || []) {
        if ((animation.pending || animation.playState === 'running')
            && animation.effect?.getKeyframes?.().some(frame => 'opacity' in frame || 'transform' in frame)) return false
      }
    }
    return true
  }
  const section = document.querySelector('[data-setup-section]')
  const allChoices = [...document.querySelectorAll('[data-setup-tier]')]
  const choices = allChoices.filter(visible)
    .map(element => ({ tier: element.dataset.setupTier, text: element.textContent.trim() }))
  const continueVisible = [...document.querySelectorAll('[data-setup-continue]')]
    .some(element => visible(element) && element.textContent.trim().length > 0)
  const setupVisible = visible(section)
  return { title: document.title, setupVisible, choices, continueVisible,
    readable: document.visibilityState === 'visible' && document.fonts?.status !== 'loading'
      && setupVisible && continueVisible && choices.length > 0 && choices.length === allChoices.length
      && choices.every(choice => choice.text.length > 0) }
}

export async function waitForReadableSetup(page, { timeoutMs = 10000, pollMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  do {
    last = await page.evaluate(`(${rendererSetupReadiness.toString()})()`)
    if (last?.readable === true) return last
    if (Date.now() >= deadline) break
    await delay(Math.min(pollMs, Math.max(0, deadline - Date.now())))
  } while (Date.now() < deadline)
  throw Object.assign(codeError('SEALED_FIRST_RUN_SETUP_NOT_READABLE'), { readiness: last })
}

export async function runSealed(options) {
  check(process.platform === 'linux' && process.getuid() !== 0, 'SEALED_ORDINARY_LINUX_USER_REQUIRED')
  check(!process.versions.electron, 'SEALED_HARNESS_REQUIRES_NODE_CLI')
  process.umask(0o077)
  const executable = assertArtifact(options.artifact)
  privateDirectory(options.evidenceDir)
  const scratch = fs.mkdtempSync(path.join(options.evidenceDir, 'linux-sealed-'))
  const shortTemp = createShortLaunchTemp()
  const profile = prepareSterileProfile({ ...sterileProfileDirectories(scratch), temp: shortTemp.directory })
  const userData = path.join(profile.appData, 'ToolsEnabled-Sealed-Test')
  privateDirectory(userData)
  const env = launchEnvironment(profile)
  const appSource = bindAppSource(options, env)
  const sourceRequire = createRequire(path.join(appSource, 'package.json'))
  const capabilityRoot = path.join(options.artifact, 'resources', 'capability')
  const report = { schemaVersion: 1, sourceMode: false, installerBuilt: false, artifact: options.artifact,
    proofMode: options.proofMode,
    launchTemp: { path: shortTemp.directory, private: true, socketPathBudgetBytes: 107, reservedSuffixBytes: 80 },
    expectedAppRef: options.appRef, expectedEngineRef: options.engineRef, gates: [], launched: false,
    onboardingCompleted: false, providerAuthenticationTested: false, readonlyInstallTested: false,
    manualStepsRemaining: ['Choose permission tier through Continue', 'Complete account choice or Not now',
      'Choose/confirm workspace', 'Exercise optional Docker setup and skip paths', 'Review and Finish',
      'Sign in to Claude/Codex and run real tree tasks', 'Relaunch and verify persisted choices'] }
  let child, identity, browser, page, ownerRoute, installedManifest, childTerminal = false, failure = null
  const owned = new Map()
  function rememberChildren(pid) {
    let children
    try { children = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number) }
    catch { return }
    for (const id of children) {
      try { const observed = processIdentity(id); if (observed) { owned.set(`${id}:${observed.start}`, observed); rememberChildren(id) } } catch { /* observed cleanup cannot claim completeness */ }
    }
  }
  try {
    if (options.proofMode === 'installed') {
      const verified = await installedPhase(options, 'before')
      installedManifest = verified.manifest; report.installedProof = { before: verified.receipt }
      report.gates.push('package-binding-before', 'installed-tree-before')
    }
    for (const [script, args, label] of [
      ...(options.proofMode === 'installed' ? [] : [['seal-artifact.mjs', ['--verify', options.artifact], 'seal-before']]),
      ['check-asar-manifest.mjs', [options.artifact], 'asar'],
      ['check-renderer-payload.mjs', [options.artifact], 'renderer'],
      ['check-no-owner-data.mjs', [options.artifact], 'privacy-before'],
      ['check-license-notices.mjs', [options.artifact], 'licenses'],
      ['check-payload-boundary.mjs', ['--ship', capabilityRoot], 'boundary-before'],
      ['check-payload-current.mjs', [capabilityRoot], 'payload-current'],
    ]) { await gate(script, args, scratch, gateEnvironment(script, env, { ...options, appSource }), label, appSource); report.gates.push(label) }
    const { extractFile } = sourceRequire('@electron/asar')
    const archive = path.join(options.artifact, 'resources', 'app.asar')
    const build = JSON.parse(extractFile(archive, 'dist/build-info.json').toString('utf8'))
    const pkg = JSON.parse(extractFile(archive, 'package.json').toString('utf8'))
    const payload = JSON.parse(fs.readFileSync(path.join(capabilityRoot, 'PAYLOAD.json'), 'utf8'))
    assertBuildMetadata(build, payload, options)
    const { getCurrentFuseWire } = sourceRequire('@electron/fuses')
    report.fuses = assertFusePolicy(await getCurrentFuseWire(executable))
    report.build = { appRef: build.ref, engineRef: payload.sourceRef, version: pkg.version,
      executableSha256: createHash('sha256').update(fs.readFileSync(executable)).digest('hex') }
    // Native spawn is intentional. _electron.launch would inject a JS/main
    // debugger entry incompatible with the shipped inspector fuse policy.
    child = spawn(executable, launchArguments(userData), { cwd: options.artifact, env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.once('close', () => { childTerminal = true })
    child.stdout.on('data', () => {})
    child.stderr.on('data', () => {}) // Drain, never archive raw runtime credential-bearing diagnostics.
    child.on('error', () => { report.spawnError = 'SEALED_GUI_SPAWN_FAILED' })
    check(child.pid, 'SEALED_GUI_SPAWN_FAILED')
    identity = processIdentity(child.pid)
    check(identity && fs.readlinkSync(`/proc/${child.pid}/exe`) === executable, 'SEALED_EXECUTABLE_MISMATCH')
    report.launched = true; report.pid = child.pid
    const deadline = Date.now() + options.timeoutMs
    let debug, target
    while (Date.now() < deadline && !target) {
      check(sameProcess(identity) && child.exitCode === null, 'SEALED_GUI_EXITED_BEFORE_READY')
      try {
        const portFile = path.join(userData, 'DevToolsActivePort'), stat = fs.lstatSync(portFile)
        check(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() && stat.size <= 1024, 'SEALED_DEBUG_FILE_INVALID')
        debug = validateDebugPort(fs.readFileSync(portFile, 'utf8')); target = await readTargets(debug.port)
      } catch (error) {
        if (['SEALED_DEBUG_PORT_INVALID', 'SEALED_DEBUG_FILE_INVALID', 'SEALED_CDP_PAGE_ENDPOINT_INVALID'].includes(error.code)) throw error
        await delay(200)
      }
    }
    check(target, 'SEALED_GUI_READY_TIMEOUT')
    browser = await connectCdp(debug.browser, 10000)
    page = await connectCdp(target.webSocketDebuggerUrl, 10000)
    await page.send('Runtime.enable')
    let runtime
    while (Date.now() < deadline) {
      runtime = await page.evaluate('(async () => typeof window.mcShell?.runtimeIdentity === "function" ? await window.mcShell.runtimeIdentity() : null)()')
      if (runtime?.ok) break
      await delay(200)
    }
    const rendererUrl = await page.evaluate('location.href')
    report.runtime = assertAttestation(runtime, { artifact: options.artifact, userData, pid: child.pid, version: pkg.version, rendererUrl })
    if (installedManifest) {
      const state = installedAppArmorState(child.pid)
      check(processIdentity(child.pid)?.start === identity.start, 'SEALED_INSTALLED_PID_CHANGED')
      report.installedRuntime = assertInstalledRuntime(runtime, installedManifest, report.build, state.label, state.restricted)
    }
    const setup = await waitForReadableSetup(page)
    report.firstRun = setup
    check(setup.readable, 'SEALED_FIRST_RUN_SETUP_NOT_READABLE')
    const screenshot = await page.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(scratch, 'first-run.png'), Buffer.from(screenshot.data, 'base64'), { flag: 'wx', mode: 0o600 })
    // Credentials stay inside this renderer expression and are never returned.
    const api = await page.evaluate(`(${rendererApiProbe.toString()})()`)
    check(api?.ok === true, 'SEALED_AUTHENTICATED_API_FAILED')
    validateLoopback(api.origin)
    const { assessBridgeApiCompatibility } = await import(pathToFileURL(path.join(appSource, 'src/generated/bridge-api-contract.js')))
    const compatibility = assessBridgeApiCompatibility(api.contract, { requiredActions: ['dispatch', 'task-get', 'launch-status'] })
    check(compatibility.ok, 'SEALED_API_CONTRACT_INCOMPATIBLE')
    report.api = { origin: api.origin, unauthorizedStatus: api.unauthorizedStatus, compatibility,
      actionCount: api.contract.actions.length, credentialsRecorded: false }
    const owner = await ownerHostProof(capabilityRoot, path.join(userData, 'capability'), child.pid)
    report.ownerHost = owner.public; ownerRoute = owner.route
    report.pageErrors = page.events.slice()
    report.pageErrorScope = 'Runtime.exceptionThrown observed after renderer CDP attachment; no raw exception text retained'
    check(report.pageErrors.length === 0, 'SEALED_RENDERER_ERRORS')
    report.acceptance = 'first-run-visible-and-authenticated-api'
  } catch (error) {
    failure = error; report.failureCode = /^[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'SEALED_ACCEPTANCE_FAILED'
    if (error.ownedPid) report.gateCleanupUnprovenPids = [error.ownedPid]
  }
  finally {
    try {
      if (child?.pid && !identity && child.exitCode === null) {
        child.kill('SIGTERM')
        throw codeError('SEALED_CLEANUP_UNPROVEN')
      }
      if (child?.pid && identity) {
      rememberChildren(child.pid)
      if (sameProcess(identity) && browser && report.runtime?.pid === child.pid) {
        try { await browser.send('Browser.close', {}, 5000) } catch { /* close often disconnects before its reply */ }
      }
      let deadline = Date.now() + 12000
      while (sameProcess(identity) && Date.now() < deadline) { rememberChildren(child.pid); await delay(100) }
      if (sameProcess(identity)) {
        report.cleanupFallback = 'SIGTERM-exact-retained-main'
        child.kill('SIGTERM')
        deadline = Date.now() + 10000
        while (sameProcess(identity) && Date.now() < deadline) await delay(100)
      }
      const remaining = [...owned.values(), identity].filter(sameProcess)
      report.cleanup = { observedDescendants: owned.size, remainingPids: remaining.map(value => value.pid),
        proofScope: 'retained main plus observed descendants; not native subtree-quiescence certification' }
      if (remaining.length) { failure ||= codeError('SEALED_CLEANUP_UNPROVEN'); report.failureCode ||= 'SEALED_CLEANUP_UNPROVEN' }
    } } catch {
      failure ||= codeError('SEALED_CLEANUP_UNPROVEN'); report.failureCode ||= 'SEALED_CLEANUP_UNPROVEN'
      report.cleanup = { proofScope: 'cleanup observation failed; no process disappearance inferred', remainingPids: child?.pid ? [child.pid] : [] }
    }
    if (report.failureCode === 'SEALED_CLEANUP_UNPROVEN' || report.cleanup?.remainingPids?.length) {
      // Do not force-kill uncertain descendants or hide their PIDs. Let the
      // caller retain this explicit failed receipt and inspect the live handle.
      child?.unref(); child?.stdout?.destroy(); child?.stderr?.destroy()
    }
    if (ownerRoute) {
      try { report.ownerHostShutdown = await ownerSocketClosed(ownerRoute) }
      catch (error) { failure ||= error; report.failureCode ||= error.code; report.ownerHostShutdown = { listenerClosed: false } }
    }
    page?.close(); browser?.close()
    if (options.proofMode === 'installed') {
      try {
        const verified = await installedPhase(options, 'after')
        report.installedProof ||= {}; report.installedProof.after = verified.receipt
        report.readonlyInstallTested = !!report.installedProof.before
        report.gates.push('package-binding-after', 'installed-tree-after')
      } catch (error) { failure ||= error; report.failureCode ||= error.code || 'SEALED_INSTALLED_POSTCHECK_FAILED' }
    }
    for (const [script, args, label] of [
      ...(options.proofMode === 'installed' ? [] : [['seal-artifact.mjs', ['--verify', options.artifact], 'seal-after']]),
      ['check-payload-boundary.mjs', ['--ship', capabilityRoot], 'boundary-after'],
      ['check-no-owner-data.mjs', [options.artifact], 'privacy-after'],
    ]) {
      try { await gate(script, args, scratch, env, label, appSource); report.gates.push(label) }
      catch (error) {
        failure ||= error; report.failureCode ||= error.code
        if (error.ownedPid) (report.gateCleanupUnprovenPids ||= []).push(error.ownedPid)
      }
    }
    report.ok = !failure
    try {
      report.launchTemp.cleanup = releaseShortLaunchTemp(shortTemp, { childTerminal: !child || childTerminal,
        remainingPids: report.cleanup?.remainingPids || [], gateCleanupUnprovenPids: report.gateCleanupUnprovenPids || [] })
    } catch (error) {
      report.launchTemp.cleanup = { path: shortTemp.directory, removed: false, reason: error.code || 'cleanup-observation-failed' }
    }
    fs.writeFileSync(path.join(scratch, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  }
  return { ok: report.ok, evidence: scratch, failureCode: report.failureCode || null }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runSealed(parseOptions(process.argv.slice(2)))
    console.log(JSON.stringify(result)); process.exitCode = result.ok ? 0 : 1
  } catch (error) { console.error(error.code || 'SEALED_HARNESS_REFUSED'); process.exitCode = 1 }
}
