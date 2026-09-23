'use strict'

/* Starts the half of the product that is not the viewer.
 *
 * ToolsEnabled discovers an action bridge on 127.0.0.1:4610-4619 and, until
 * now, something else had to have started it -- in practice a developer, by
 * hand, out of a checkout. On a customer's machine nothing did, so discovery
 * found nothing and every write action answered BRIDGE_UNREACHABLE. This module
 * is the missing supervisor: the installed app starts its own capability layer
 * from its own resources.
 *
 * THE RUNTIME QUESTION, ANSWERED WITHOUT SHIPPING A SECOND RUNTIME.
 * The capability layer is Node code, and the obvious reading of "package the
 * capability layer" is "bundle a Node runtime too", which is another ~50 MB to
 * ship, sign and update. It is unnecessary: the Electron binary already IS a
 * Node runtime, and setting ELECTRON_RUN_AS_NODE=1 makes it behave as one. So
 * the layer runs on process.execPath -- the same executable the user launched.
 *
 * That variable is load-bearing in BOTH directions, which is why it is set
 * explicitly here and deleted explicitly below. Set, it gives the child a Node.
 * Inherited by the GUI process, it turns Electron into a headless Node that
 * exits 0 with no output and no window -- the "silent exit" that cost this
 * project two wrong root causes in one day. A supervisor that spawns Node from
 * a GUI app touches both edges of that trap, so neither is left to chance:
 * the child gets the variable, and nothing else inherits it.
 */

const { spawn: nodeSpawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const PAYLOAD_RECORD = 'PAYLOAD.json'
const START_TIMEOUT_MS = 30_000
const STOP_TIMEOUT_MS = 5_000

function failure(code, reason) {
  return { ok: false, code, reason }
}

/* Where the payload lives. Packaged, electron-builder places extraResources
 * beside app.asar under resources/. In a checkout it is the staging directory
 * `npm run pack:capability` writes. Both are asked for by existence, not
 * assumed from a flag, so a packaged build with a missing payload reports that
 * plainly instead of silently resolving a path that is not there. */
function resolveCapabilityRoot({
  resourcesPath = process.resourcesPath,
  repoRoot = path.join(__dirname, '..'),
  exists = fs.existsSync,
} = {}) {
  const candidates = []
  if (typeof resourcesPath === 'string' && resourcesPath) candidates.push(path.join(resourcesPath, 'capability'))
  candidates.push(path.join(repoRoot, 'capability'))
  const found = candidates.find((candidate) => exists(path.join(candidate, PAYLOAD_RECORD)))
  return found || null
}

function readPayloadRecord(root, { readFileSync = fs.readFileSync } = {}) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path.join(root, PAYLOAD_RECORD), 'utf8'))
  } catch (error) {
    return failure('CAPABILITY_PAYLOAD_UNREADABLE', `The capability payload record could not be read: ${error.message}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return failure('CAPABILITY_PAYLOAD_INVALID', 'The capability payload record is not an object.')
  }
  if (typeof parsed.bridgeEntrypoint !== 'string' || !parsed.bridgeEntrypoint) {
    return failure('CAPABILITY_PAYLOAD_INVALID', 'The capability payload record names no bridge entrypoint.')
  }
  if (typeof parsed.ownerHostModule !== 'string' || parsed.ownerHostModule !== 'src/owner-host.js'
      || !Array.isArray(parsed.hostModules) || !parsed.hostModules.includes(parsed.ownerHostModule)) {
    return failure('CAPABILITY_PAYLOAD_INVALID', 'The capability payload record names no app-owned session authority.')
  }
  return { ok: true, record: parsed }
}

/* The environment handed to the capability layer. Explicitly constructed
 * rather than spread-and-patched so that what the child gets is readable in
 * one place.
 *
 * TOOLSENABLED_STATE_ROOT IS THE SECOND LOAD-BEARING VARIABLE HERE. It names
 * the directory the layer writes into -- state/, logs/, vault/, captures/,
 * profiles/, reports/. Without it the layer resolved those from its own module
 * directory, which packaged is the INSTALL directory, and a measured session
 * left a live bearer token, the signed audit ledger and the customer's
 * credential vault sitting in a directory that the next update deletes and
 * that a per-machine install makes read-only. shell/main.cjs sets it to
 * <userData>/capability and passes it here; the layer refuses a relative value
 * rather than resolving one against a cwd nobody chose. */
function childEnvironment(base, { stateRoot } = {}) {
  const environment = { ...base }
  environment.ELECTRON_RUN_AS_NODE = '1'
  if (typeof stateRoot === 'string' && stateRoot) environment.TOOLSENABLED_STATE_ROOT = stateRoot
  delete environment.ELECTRON_NO_ATTACH_CONSOLE
  return environment
}

/* Strip the Node-mode variable from an environment that is about to launch a
 * GUI Electron process. Exported because the acceptance harness needs exactly
 * this and must not reimplement it from memory. */
function guiEnvironment(base = process.env) {
  const environment = { ...base }
  delete environment.ELECTRON_RUN_AS_NODE
  delete environment.ELECTRON_NO_ATTACH_CONSOLE
  return environment
}

/* The bridge prints one JSON line on stdout when it is listening, and that
 * line carries the port it actually bound and the path to this boot's
 * bootstrap proof. Both are needed and neither is guessable: the port is
 * chosen from a range at runtime, and the proof is a fresh secret per boot. */
function startCapabilityLayer({
  root,
  origin,
  workspaceRoot,
  stateRoot,
  execPath = process.execPath,
  spawn = nodeSpawn,
  env = process.env,
  timeoutMs = START_TIMEOUT_MS,
  resourceChannel = null,
  lifecycleChannel = null,
} = {}) {
  if (!root) {
    return Promise.resolve(failure(
      'CAPABILITY_PAYLOAD_ABSENT',
      'No capability payload is present. A build that ships the viewer alone cannot reach its own capability layer; run `npm run pack:capability` before packaging.',
    ))
  }
  const payload = readPayloadRecord(root)
  if (!payload.ok) return Promise.resolve(payload)

  const entry = path.join(root, payload.record.bridgeEntrypoint)
  if (!fs.existsSync(entry)) {
    return Promise.resolve(failure('CAPABILITY_ENTRYPOINT_ABSENT', `The capability payload names ${payload.record.bridgeEntrypoint}, which is not in the payload.`))
  }

  if (resourceChannel !== null && typeof resourceChannel?.attach !== 'function') {
    return Promise.resolve(failure('CAPABILITY_RESOURCE_AUTHORITY_REQUIRED', 'The app-owned work service has no resource authority connection.'))
  }
  if (lifecycleChannel !== null && typeof lifecycleChannel?.attach !== 'function') {
    return Promise.resolve(failure('CAPABILITY_LIFECYCLE_AUTHORITY_REQUIRED', 'The app-owned work service has no private shutdown connection.'))
  }
  const args = [entry, '--origin', origin, '--root', `main=${workspaceRoot}`,
    ...(resourceChannel ? ['--resource-channel', 'inherited'] : []),
    ...(lifecycleChannel ? ['--research-lifecycle-channel', 'inherited'] : [])]
  let child
  let resourceConnection = null
  let lifecycleConnection = null
  try {
    child = spawn(execPath, args, { env: childEnvironment(env, { stateRoot }), windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', ...(resourceChannel || lifecycleChannel ? ['ipc'] : [])] })
    if (lifecycleChannel) {
      lifecycleConnection = lifecycleChannel.attach(child)
      if (!lifecycleConnection || typeof lifecycleConnection.close !== 'function') throw new Error('The app did not retain its private research shutdown connection.')
      child.once('exit', () => lifecycleConnection.close())
    }
    if (resourceChannel) {
      resourceConnection = resourceChannel.attach(child)
      if (!resourceConnection || typeof resourceConnection.close !== 'function') throw new Error('The resource authority did not retain its private child connection.')
      child.once('exit', () => resourceConnection.close())
    }
  } catch (error) {
    try { lifecycleConnection?.close() } catch { /* a lost connection is not cleanup proof */ }
    try { resourceConnection?.close() } catch { /* failure remains authoritative */ }
    try { child?.kill() } catch { /* failure remains authoritative */ }
    return Promise.resolve(failure('CAPABILITY_SPAWN_FAILED', `The capability layer could not be started: ${error.message}`))
  }

  return new Promise((resolve) => {
    let settled = false
    let stdout = ''
    let stderr = ''

    const settle = (result, { terminate = false } = {}) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (terminate) {
        try { child.kill() } catch { /* the startup failure is authoritative */ }
      }
      resolve(result)
    }

    const timer = setTimeout(() => {
      try { child.kill() } catch { /* the timeout result is authoritative */ }
      settle(failure('CAPABILITY_START_TIMEOUT', `The capability layer did not report a listening address within ${timeoutMs}ms.`))
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      if (settled) return
      stdout += chunk
      const newline = stdout.indexOf('\n')
      if (newline === -1) return
      let announced
      try { announced = JSON.parse(stdout.slice(0, newline)) } catch {
        return settle(failure('CAPABILITY_START_UNREADABLE', 'The capability layer printed a startup line that is not JSON.'), { terminate: true })
      }
      if (announced?.ok !== true || typeof announced.baseUrl !== 'string') {
        return settle(failure(announced?.code || 'CAPABILITY_START_REFUSED', announced?.message || 'The capability layer refused to start.'), { terminate: true })
      }
      settle({
        ok: true,
        baseUrl: announced.baseUrl,
        port: announced.port,
        pid: announced.pid,
        bootstrapProofFile: announced.bootstrapProofFile,
        child,
      })
    })

    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => settle(failure('CAPABILITY_SPAWN_FAILED', `The capability layer could not be started: ${error.message}`)))
    child.on('exit', (code) => settle(failure(
      'CAPABILITY_EXITED',
      `The capability layer exited with code ${code} before reporting an address.${stderr ? ` ${stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`,
    )))
  })
}

/* WHICH AGENT PROGRAMS THE INSTALLED AUTHORITY WILL BIND A SESSION FOR.
 *
 * THE DEFECT THIS CLOSES, measured on this computer 2026-09-11. The owner-host
 * module keeps a closed set of agent actors, and validBindSession() refuses a
 * principal whose provider is not in it. That set omitted `grok`, so every Grok
 * tree start was refused with OWNER_HOST_SESSION_BINDING_INVALID -- after the
 * menu had offered the row, after the seat was written, and after the person
 * had waited for a start that could never happen. This app had no way to know:
 * resolveStartTier() gates on the LAUNCHER module being present, which for Grok
 * it is, and nothing anywhere asked the authority what it would accept.
 *
 * READ FROM THE MODULE THAT DOES THE REFUSING, never from a list kept here. A
 * second list is one that drifts, and its drift shows up as a menu that
 * disagrees with the press -- which is this same defect with a different cause.
 * The set this reads and the set validBindSession() tests are one frozen value
 * in one loaded module.
 *
 * ABSENT IS UNKNOWN, AND UNKNOWN REFUSES NOTHING. A payload cut before the
 * module exported its actor set answers null here, and every caller then
 * behaves exactly as it did before this function existed. Inventing a set for
 * an older payload would invent refusals for providers that start perfectly
 * well on it, which is worse than the late refusal this replaces. */
function readAgentActors(module) {
  const declared = module?.AGENT_ACTORS
  const values = declared instanceof Set ? [...declared]
    : Array.isArray(declared) ? [...declared]
      : null
  if (!values || values.length === 0) return null
  if (!values.every(value => typeof value === 'string' && value.length > 0 && value.length <= 32)) return null
  return Object.freeze([...new Set(values)])
}

/* The agent-session authority belongs to the app instance, not to a scheduled
 * task and not to a disk-readable control bearer.  The payload module owns the
 * pipe/data plane; this shell retains the only bind/revoke references in
 * memory and injects them into createAgentHost(). */
async function startAppOwnedOwnerHost({ root } = {}) {
  if (!root) return failure('OWNER_HOST_PAYLOAD_ABSENT', 'The installed agent-session authority is unavailable.')
  const payload = readPayloadRecord(root)
  if (!payload.ok) return payload
  const entry = path.join(root, payload.record.ownerHostModule)
  if (!fs.existsSync(entry)) {
    return failure('OWNER_HOST_ENTRYPOINT_ABSENT', 'The installed agent-session authority is missing.')
  }
  try {
    const module = require(entry)
    if (!module || typeof module.createOwnerHost !== 'function') {
      return failure('OWNER_HOST_MODULE_INVALID', 'The installed agent-session authority cannot be loaded.')
    }
    const host = module.createOwnerHost()
    if (!host || typeof host.listen !== 'function' || typeof host.close !== 'function'
        || typeof host.bindSession !== 'function' || typeof host.revokeSession !== 'function'
        || typeof host.assertSession !== 'function') {
      return failure('OWNER_HOST_MODULE_INVALID', 'The installed agent-session authority is incomplete.')
    }
    const agentActors = readAgentActors(module)
    await host.listen()
    return {
      ok: true,
      host,
      authority: Object.freeze({
        bind: (value, scope, admission) => host.bindSession(value, scope, admission),
        /* Versioned like admission, scope and tool mode above it, and for the
           same reason: an older payload that declares nothing leaves every
           consumer on its pre-existing behaviour rather than on a guess. */
        ...(agentActors ? { actorsVersion: 1, agentActors } : {}),
        ...(host.admissionVersion === 1 && typeof host.admitSession === 'function'
          ? { admissionVersion: 1, admit: value => host.admitSession(value) } : {}),
        ...(host.cancelVersion === 2 && typeof host.cancelSessionWork === 'function'
          && typeof host.resumeSessionWork === 'function'
          ? { cancelVersion: 2, cancelWork: value => host.cancelSessionWork(value),
            resumeWork: value => host.resumeSessionWork(value) } : {}),
        revoke: value => host.revokeSession(value),
        assert: value => host.assertSession(value),
        ...(host.toolModeVersion === 1 ? { toolModeVersion: 1 } : {}),
        ...(host.researchAccessVersion === 1 ? { researchAccessVersion: 1 } : {}),
        ...(host.scopeVersion === 1 && typeof host.readSessionScope === 'function'
          ? { scopeVersion: 1, readScope: value => host.readSessionScope(value) } : {}),
      }),
      pipeName: host.pipeName,
      generation: host.generation,
    }
  } catch (error) {
    return failure(
      typeof error?.code === 'string' ? error.code : 'OWNER_HOST_START_FAILED',
      'The app-owned agent-session authority could not be started. Close ToolsEnabled, reopen it normally (not as administrator), and try again.',
    )
  }
}

function stopAppOwnedOwnerHost(host, { requireClose = false } = {}) {
  if (!host) return Promise.resolve()
  if (typeof host.close !== 'function') return requireClose
    ? Promise.reject(Object.assign(new Error('The session authority has no close operation.'), { code: 'OWNER_HOST_CLOSE_UNCONFIRMED' }))
    : Promise.resolve()
  try { return Promise.resolve(host.close()) } catch (error) { return Promise.reject(error) }
}

/* The bootstrap proof is a per-boot secret the bridge writes to an owner-ACL'd
 * file; the renderer cannot read files, so the shell reads it and hands it
 * over. Read on demand rather than cached at startup: the file is rewritten
 * whenever the layer restarts, and a cached value would authorize nothing
 * while looking exactly like a value that should work. */
function readCapabilityProof(bootstrapProofFile, { readFileSync = fs.readFileSync } = {}) {
  if (typeof bootstrapProofFile !== 'string' || !bootstrapProofFile) {
    return failure('CAPABILITY_PROOF_UNAVAILABLE', 'The capability layer reported no bootstrap proof file.')
  }
  let record
  try {
    record = JSON.parse(readFileSync(bootstrapProofFile, 'utf8'))
  } catch (error) {
    return failure('CAPABILITY_PROOF_UNAVAILABLE', `The capability layer bootstrap proof could not be read: ${error.message}`)
  }
  if (!record || typeof record.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(record.token)) {
    return failure('CAPABILITY_PROOF_INVALID', 'The capability layer bootstrap proof file is malformed.')
  }
  return { ok: true, proof: record.token }
}

/* STOP MEANS THE WHOLE TREE IS GONE, NOT THAT A SIGNAL WAS SENT.
 *
 * This used to resolve the moment the escalation timer fired, before the child
 * had exited, and it resolved at once if kill() threw. The local-data reset
 * awaits this and then sweeps the per-user state root, so "resolved" was read
 * as "nothing is writing any more" while the layer could still be alive -- and
 * its GRANDCHILDREN certainly were: every vault verb is a synchronous
 * powershell.exe child of the layer, a kill of the blocked parent never reaches
 * it, and its trailing access-log write recreated the vault directory after
 * the sweep (the one survivor uninstall-reset-packaged-qa kept finding).
 *
 * Now: signal, escalate to SIGKILL on the timer, and in every case wait for the
 * real exit event before resolving; on Windows, once the parent is down, ask
 * the OS to end the process tree it left behind (taskkill /T on the parent pid
 * takes orphaned grandchildren by parent-pid lineage). The reap is best-effort
 * and bounded. Callers that need exit proof before changing state must set
 * requireExit; an ordinary app-close deadline may still settle unconfirmed. */
function stopCapabilityLayer(child, { timeoutMs = STOP_TIMEOUT_MS, reapTree = reapProcessTree, platform = process.platform, requireExit = false } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (observedExit = false) => {
      if (settled) return
      settled = true
      if (platform === 'win32' && Number.isInteger(child.pid)) {
        try { reapTree(child.pid) } catch { /* best effort: the parent is already gone */ }
      }
      if (requireExit && !observedExit) reject(Object.assign(new Error('The capability layer did not confirm exit before the stop deadline.'), { code: 'CAPABILITY_STOP_UNCONFIRMED' }))
      else resolve()
    }
    const escalate = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* the exit listener below still decides */ }
    }, timeoutMs)
    /* Hard stop so a child that ignores every signal cannot hang the reset
       forever; three timeouts is generous for a process that has been SIGKILLed
       after one. Resolving here is the ONLY path that does not see an exit, and
       it still reaps the tree. Audit identity maintenance and local-data reset
       require an observed exit and refuse this unconfirmed deadline. */
    const deadline = setTimeout(finish, timeoutMs * 3)
    child.once('exit', () => { clearTimeout(escalate); clearTimeout(deadline); finish(true) })
    try { child.kill() } catch { /* already dead or unkillable: the timers and the exit listener decide */ }
  })
}

/* Windows ends only the named process on kill(); children it spawned keep
 * running with a dead parent. taskkill /T walks the parent-pid lineage and
 * ends them too; /F because the parent is already being force-stopped. Errors
 * (no such process, access denied on an already-exited pid) are swallowed by
 * the caller: this is a sweep of stragglers, not the stop itself. */
function reapProcessTree(pid, { spawnSync = require('node:child_process').spawnSync } = {}) {
  spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 })
}

module.exports = {
  PAYLOAD_RECORD,
  START_TIMEOUT_MS,
  childEnvironment,
  guiEnvironment,
  readAgentActors,
  readCapabilityProof,
  readPayloadRecord,
  resolveCapabilityRoot,
  startAppOwnedOwnerHost,
  startCapabilityLayer,
  stopAppOwnedOwnerHost,
  stopCapabilityLayer,
}
