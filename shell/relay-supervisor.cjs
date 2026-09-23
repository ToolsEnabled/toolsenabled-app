'use strict'

/* THE LEG THAT MAKES THIS COMPUTER REACHABLE, AND THE SWITCH THAT DECIDES
 * WHETHER A BROWSER MAY DO MORE THAN LOOK.
 *
 * WHY THIS FILE EXISTS. tools/relay-shell.js is the machine end of the relay:
 * it keeps one sealed session to the account's relay edge alive and serves the
 * tunnelled requests a signed-in browser makes of this machine. It now ships
 * inside the capability payload (commit "The relay leg ships"), and until this
 * module existed nothing on a customer's machine ever started it -- so an
 * installed copy was, in the owner's scenario, a home computer that Bob could
 * sign in beside and still not reach. This is the supervisor: the shell starts
 * the relay leg from its own payload and keeps it up, exactly as
 * shell/capability-layer.cjs does for the mission bridge beside it.
 *
 * WHAT IT DELIBERATELY IS NOT. It is not a second copy of the relay's own
 * reconnect logic. tools/relay-shell.js already backs off between sessions
 * (2s -> 60s) and treats "the peer is not there right now" as a state rather
 * than an error; that loop stays where it is. This supervisor answers the one
 * question the child cannot answer about itself: what happens when the process
 * DIES. It respawns, with its own floor, so a child that crashes on its first
 * line cannot become a spawn loop -- and a child that exits cleanly is still
 * brought back, because a relay leg that stops is a machine that quietly
 * stopped being reachable, which is precisely the silent failure this product
 * keeps refusing to ship.
 *
 * THE ENVIRONMENT IS AN ALLOWLIST, NOT A COPY, AND THAT IS A DEPARTURE.
 * childEnvironment() in shell/capability-layer.cjs spreads the parent's
 * environment and patches two variables into it, and safeLaunchEnvironment()
 * in the payload takes the other established shape -- copy everything, strip
 * the billing credentials by name. Neither shape is used here. This child is
 * the ONE process on the machine that holds the agent facade's per-boot bearer
 * AND talks to the network, so the question "which variable did nobody think
 * to strip" must not be answerable. An allowlist cannot leak a credential
 * nobody has heard of yet; a denylist can, and a spread does by default. The
 * kept names are below, each with the reason it is kept.
 *
 * THE FACADE TOKEN IS HANDED OVER AT SPAWN AND WRITTEN NOWHERE.
 * docs/relay-agent-facade-DESIGN.md §2.2(c) weighed a token file -- the
 * mission bridge's own pattern -- and refused it: a file invites a second
 * reader, and the spawn-time handoff keeps the set of parties that ever hold
 * the token at exactly two processes, both ours. So the credentials cross in
 * the child's environment or they do not cross at all. Nothing here writes
 * them to disk, logs them, or puts them in status().
 *
 * STATUS CARRIES NO IDENTIFIERS. What this module reports about itself is
 * a word from a closed set and three plain numbers. The child's own output is
 * identifier-free by its own discipline, but it is never turned into status
 * either: `lastReason` is derived from the exit ITSELF, never from anything
 * the child printed, so no pair id, device id, machine name or path can reach
 * a status surface through this file even if a future child forgets its
 * manners.
 *
 * NOTHING HERE REQUIRES ELECTRON. Every dependency -- the spawn, the payload
 * root, the facade credentials, the enrolment predicate, the clock, the timers
 * -- is injected, which is what lets tools/test/relay-supervisor.test.mjs
 * drive a full crash-and-backoff history in microseconds with no real child
 * and no real sleep.
 */

const fs = require('node:fs')
const path = require('node:path')

/* WHERE THE RELAY LEG IS INSIDE THE PAYLOAD. Declared in
   tools/capability-manifest.json as a `spawnedProgram` root, which is what
   makes the packer walk its require() graph and stage its whole closure. */
const RELAY_ENTRY = path.join('tools', 'relay-shell.js')

/* THE FLOOR, THE CEILING, AND WHAT COUNTS AS A CHILD THAT LIVED.
   A child that survives a full minute has demonstrably not failed on startup,
   so its next failure starts from the floor again rather than inheriting the
   patience earned by an unrelated crash an hour ago. */
const RESTART_FLOOR_MS = 2_000
const RESTART_CEILING_MS = 60_000
const STABLE_AFTER_MS = 60_000

/* How long a stop() waits for a signalled child before escalating. The same
   five seconds stopCapabilityLayer() gives the bridge, and for the same
   reason: a quit must not hang on a child that ignores the first signal, and
   it must not leave one behind either. */
const STOP_TIMEOUT_MS = 5_000

/* THE CLOSED SET `lastReason` IS DRAWN FROM. A word, never a sentence built
   out of something a process said. The test asserts membership, so a new
   reason has to be added here on purpose. */
const REASONS = Object.freeze({
  NOT_ENROLLED: 'not-enrolled',
  PAYLOAD_ABSENT: 'payload-absent',
  ENTRYPOINT_ABSENT: 'entrypoint-absent',
  STATE_ROOT_UNKNOWN: 'state-root-unknown',
  SPAWN_FAILED: 'spawn-failed',
  EXITED_CLEAN: 'child-exited-clean',
  EXITED_ERROR: 'child-exited-error',
  SIGNALLED: 'child-signalled',
  STOPPED: 'stopped',
  STOPPING: 'stopping',
  STOP_UNCONFIRMED: 'stop-unconfirmed',
})
const REASON_VALUES = Object.freeze(Object.values(REASONS))

/* THE VARIABLES THE RELAY CHILD IS GIVEN FROM THE PARENT'S ENVIRONMENT, and
 * why each one is on the list. Everything not named here is not passed, which
 * includes NODE_OPTIONS (an inherited one can inject a require into a process
 * holding a bearer token), the proxy variables (they redirect a sealed
 * session's transport, and nothing in the relay leg asks for them), every
 * provider credential the payload's own tripwire enumerates, and
 * TOOLSENABLED_VAULT_PATH (the state root already decides where the vault is;
 * a second, inherited answer is how two half-populated state roots happen).
 *
 * Measured against what the leg actually reaches for: powershell.exe is
 * resolved on PATH for every vault read, the vault script wants a working
 * temp and system root, and the engine's runtime reads ComSpec, LOCALAPPDATA,
 * APPDATA and ProgramFiles when it resolves helper programs. */
const INHERITED_ENVIRONMENT_KEYS = Object.freeze([
  /* The vault read spawns powershell.exe by name. */
  'PATH',
  'PATHEXT',
  /* Windows itself: CreateProcess and every system DLL lookup. */
  'SystemRoot',
  'SystemDrive',
  'windir',
  /* Spelled the way the engine's runtime reads it. Windows resolves
     environment names case-insensitively in both directions, so one spelling
     is enough -- and listing two would put two keys with one value into the
     block handed to the child. */
  'ComSpec',
  /* Where the engine's runtime looks for helper programs and per-user data. */
  'LOCALAPPDATA',
  'APPDATA',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'USERPROFILE',
  /* A writable temp is required by the vault script and by TLS on some
     platforms; HOME is the same answer off Windows. */
  'TEMP',
  'TMP',
  'HOME',
  // Linux session fields are added by linuxSessionEnvironment after validation.
])

/* THE SWITCH THE OWNER RULED ON: DEFAULT OFF, and asked for only after a
 * person has connected this computer to our servers and turned web access on.
 *
 * WHERE IT LIVES AND WHY. shell/renderer-prefs.cjs is the store this shell
 * already reads durable choices out of in the main process -- the boot theme,
 * the chosen setup profile, the close warning -- and its keys are `mc.*`. The
 * other candidate, shell/product-settings.cjs, is the payload's settings
 * registry, and its own header states the rule this decision obeys: a registry
 * row without a control in the software is a lie. The control is not a
 * registry row: it is the switch in the connect section of Settings
 * (src/connect-computer-settings.js, labelled by WEB_DRIVE_CONTROL_LABEL in
 * src/device-claim-flow.js), which writes this key over `mc-prefs:write` from
 * the window -- where the owner said the question gets asked, at the moment
 * the computer lands on an account. The key and the value are repeated in
 * that ESM module because it cannot import this one; the parity is pinned in
 * tools/test/relay-supervisor.test.mjs.
 *
 * FAIL CLOSED IS STRUCTURAL, NOT INCIDENTAL. Four separate ways of not knowing
 * -- no store, a store that throws, a damaged record, a value that is not
 * exactly 'on' -- all answer false, and each has its own line, because
 * "unreadable" resolving to "may write" through some clever shortcut is the
 * defect that would matter here. There is no branch in this function that can
 * return true without having read the string 'on' out of an undamaged record.
 */
const WEB_DRIVE_PREF_KEY = 'mc.relay.web-drive'
const WEB_DRIVE_ON = 'on'

function webDriveMayWrite(prefs) {
  if (!prefs || typeof prefs.snapshot !== 'function') return false
  let snapshot
  try {
    snapshot = prefs.snapshot()
  } catch {
    /* A store that cannot answer has not granted anything. */
    return false
  }
  if (!snapshot || typeof snapshot !== 'object') return false
  /* renderer-prefs reports `damaged` when the file could not be read or
     parsed. Its values then read empty, which would answer false anyway -- but
     relying on that would make the guarantee an accident of another module's
     internals rather than a decision made here. */
  if (snapshot.damaged) return false
  const values = snapshot.values
  if (!values || typeof values !== 'object' || Array.isArray(values)) return false
  return values[WEB_DRIVE_PREF_KEY] === WEB_DRIVE_ON
}

function requireFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`createRelaySupervisor requires ${name}`)
  }
  return value
}

/* The facade's credentials, resolved at SPAWN time rather than at
   construction. The facade binds an ephemeral port and mints a per-boot bearer
   after this supervisor is built, and a respawned child must be handed the
   values that are current then -- a cached pair would authorize nothing while
   looking exactly like a pair that should work, which is the mistake
   readCapabilityProof() records for the bridge's own proof file. Absent or
   half-present credentials yield NEITHER variable: the composite bridge then
   answers AGENT_FACADE_ABSENT honestly instead of forwarding with a blank
   bearer. */
function facadeCredentials(facade) {
  let resolved = facade
  if (typeof facade === 'function') {
    try { resolved = facade() } catch { return null }
  }
  if (!resolved || typeof resolved !== 'object') return null
  const { origin, token } = resolved
  if (typeof origin !== 'string' || !origin) return null
  if (typeof token !== 'string' || !token) return null
  return { origin, token }
}

/* Enrollment and relay children both read the Linux vault through the owner's
   existing GNOME session. Retain only an explicit, single local Unix bus; no
   remote transport, autolaunch, command transport or fallback address. Syntax
   is not ownership: the vault must verify the actual socket peer and keyring.
   D-Bus address values use byte escapes, not URL query-string decoding. */
function linuxSessionEnvironment(source) {
  if (process.platform !== 'linux') return {}
  const address = source.DBUS_SESSION_BUS_ADDRESS
  if (typeof address !== 'string' || address.length > 4096 || !address.startsWith('unix:')
    || /[\x00-\x20\x7f;]/.test(address)) return {}
  const fields = address.slice(5).split(',')
  if (fields.length > 2) return {}
  let socket = null
  let guid = false
  for (const field of fields) {
    if (/^guid=[a-fA-F0-9]{32}$/.test(field) && !guid) { guid = true; continue }
    const match = /^(path|abstract)=((?:[-0-9A-Za-z_/.\*]|%[a-fA-F0-9]{2})+)$/.exec(field)
    if (!match || socket !== null) return {}
    const value = match[2].replace(/%([a-fA-F0-9]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    if (/[\x00-\x1f\x7f]/.test(value)) return {}
    if (match[1] === 'path' && (!path.posix.isAbsolute(value) || value === '/'
      || path.posix.normalize(value) !== value)) return {}
    socket = value
  }
  if (socket === null) return {}
  const runtime = source.XDG_RUNTIME_DIR
  if (runtime !== undefined && (typeof runtime !== 'string' || runtime.length > 4096
    || !path.posix.isAbsolute(runtime) || runtime === '/' || path.posix.normalize(runtime) !== runtime
    || /[\x00-\x1f\x7f]/.test(runtime))) return {}
  return { DBUS_SESSION_BUS_ADDRESS: address, ...(runtime === undefined ? {} : { XDG_RUNTIME_DIR: runtime }) }
}

/* The child's whole environment, built key by key from the shared allowlist
   and the Linux-only session fields validated above. `base` is never spread. */
function relayChildEnvironment(base, { stateRoot, facade } = {}) {
  const environment = {}
  const source = base && typeof base === 'object' ? base : {}
  for (const key of INHERITED_ENVIRONMENT_KEYS) {
    const value = source[key]
    if (typeof value === 'string' && value !== '') environment[key] = value
  }
  Object.assign(environment, linuxSessionEnvironment(source))
  /* The same load-bearing variable shell/capability-layer.cjs sets, for the
     same reason: the child is spawned on the Electron binary, and this is what
     makes that binary behave as the Node runtime the payload expects. */
  environment.ELECTRON_RUN_AS_NODE = '1'
  environment.TOOLSENABLED_STATE_ROOT = stateRoot
  if (facade) {
    environment.TOOLSENABLED_AGENT_FACADE_ORIGIN = facade.origin
    environment.TOOLSENABLED_AGENT_FACADE_TOKEN = facade.token
  }
  return environment
}

/**
 * Supervise the machine's relay leg.
 *
 * @param {object} deps
 * @param {Function} deps.spawn            child_process.spawn, or a stand-in
 * @param {Function} deps.resolvePayloadRoot  answers the staged payload's root, or null
 * @param {object|Function|null} deps.facade  { origin, token } for the agent facade, or a
 *                                            function answering them, or null while none exists
 * @param {Function} deps.isEnrolled       true when this machine has a relay pair recorded
 * @param {Function} [deps.log]            one line of identifier-free progress
 * @param {Function} [deps.now]            the clock, injected so backoff is testable
 * @param {string}   [deps.stateRoot]      stated rather than inherited; defaults to the
 *                                         parent's own TOOLSENABLED_STATE_ROOT
 */
function createRelaySupervisor({
  spawn,
  resolvePayloadRoot,
  facade = null,
  isEnrolled,
  log = () => {},
  now = Date.now,
  execPath = process.execPath,
  env = process.env,
  exists = fs.existsSync,
  stateRoot = undefined,
  setTimeout: schedule = setTimeout,
  clearTimeout: cancel = clearTimeout,
} = {}) {
  requireFunction(spawn, 'spawn')
  requireFunction(resolvePayloadRoot, 'resolvePayloadRoot')
  requireFunction(isEnrolled, 'isEnrolled')
  const remoteWorkspace = require('./remote-workspace-client.cjs').createRemoteWorkspaceClient()

  /* Stated by the caller, or the value this process was started with. A
     relative one is refused rather than resolved against a working directory
     nobody chose -- the payload refuses it too, and a refusal here names the
     cause while a refusal there is a child that exited before it said why. */
  const resolvedStateRoot = typeof stateRoot === 'string' && stateRoot
    ? stateRoot
    : (env && typeof env.TOOLSENABLED_STATE_ROOT === 'string' ? env.TOOLSENABLED_STATE_ROOT : '')

  let child = null
  let running = false
  let stopped = true
  let restarts = 0
  let lastExitAt = null
  let lastReason = null
  let restartTimer = null
  let stopFlight = null
  /* The last lines the leg said, for status(). See the note in the spawn path. */
  const recentLines = []
  const MAX_RECENT_LINES = 40
  let nextDelayMs = RESTART_FLOOR_MS
  let startedAt = 0

  function refuse(reason) {
    lastReason = reason
    if (!child) running = false
    log(`relay leg not started: ${reason}`)
    return { ok: false, code: reason }
  }

  function launch() {
    restartTimer = null
    if (stopped) return refuse(REASONS.STOPPED)
    let enrolled = false
    try { enrolled = isEnrolled() === true } catch { /* closed */ }
    if (!enrolled) return refuse(REASONS.NOT_ENROLLED)
    const root = resolvePayloadRoot()
    if (typeof root !== 'string' || !root) return refuse(REASONS.PAYLOAD_ABSENT)
    const entry = path.join(root, RELAY_ENTRY)
    /* A payload packed before the relay leg was a declared spawnedProgram does
       not contain this file. That is a build that cannot be driven from the
       web, and it says so once rather than spawning a path that is not there
       every two seconds. */
    let present = false
    try { present = exists(entry) } catch { present = false }
    if (!present) return refuse(REASONS.ENTRYPOINT_ABSENT)
    if (!resolvedStateRoot || !path.isAbsolute(resolvedStateRoot)) return refuse(REASONS.STATE_ROOT_UNKNOWN)

    const credentials = facadeCredentials(facade)
    let spawned
    try {
      spawned = spawn(execPath, [entry], {
        env: relayChildEnvironment(env, { stateRoot: resolvedStateRoot, facade: credentials }),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      })
    } catch {
      /* The error's message is not kept: it names a path. Nor is lastExitAt
         moved -- nothing exited, and a field that means "when the child last
         died" must not be set by a child that never lived. */
      return scheduleRestart(REASONS.SPAWN_FAILED)
    }

    child = spawned
    remoteWorkspace.attach(spawned)
    running = true
    startedAt = now()
    log(`relay leg started${credentials ? ' with the agent facade' : ' without an agent facade'}`)

    /* THE CHILD'S OWN ACCOUNT OF WHY IT STOPPED, KEPT.
     *
     * These pipes were drained and dropped: read only so a long-running child
     * could not block on a full pipe, with nothing stored and nothing reaching
     * status(). The draining is still necessary and still happens. Throwing the
     * lines away was the mistake.
     *
     * When a leg fails, those lines are the ONLY record anywhere of why.
     * Measured 2026-08-22: an agent standing up a real machine could not find
     * out why its leg would not connect, and got there in the end by killing
     * the app and running tools/relay-shell.js by hand to watch it speak. That
     * is not a diagnosis path anybody has on a customer's computer.
     *
     * It is the third time in one day the same shape has cost hours -- the
     * relay could not say why it closed a socket, the session could not say why
     * it rejected a frame, and this could not say why a leg died.
     *
     * THESE LINES DO NOT GO INTO status(), AND THAT IS DELIBERATE. This file's
     * header already weighed exactly that and refused it: `lastReason` is
     * derived from the EXIT, never from anything the child printed, so that no
     * pair id, device id, machine name or path can reach a surface a page could
     * render even if a future child forgets its manners. That reasoning is
     * still right and I am not weakening it to save myself a lookup.
     *
     * So they go to the shell's own log when the leg dies -- where an operator
     * reads them and no renderer can -- and status() keeps carrying a word from
     * a closed set and three plain numbers.
     *
     * Bounded to the last 40 lines, because this is a hint for whoever is
     * looking, not a log file. Long lines are clipped so a runaway child cannot
     * grow it without bound. */
    const keepLine = (chunk) => {
      const text = String(chunk)
      for (const raw of text.split(/[\r\n]+/)) {
        const line = raw.trim()
        if (!line) continue
        recentLines.push(line.length > 300 ? `${line.slice(0, 300)}…` : line)
        while (recentLines.length > MAX_RECENT_LINES) recentLines.shift()
      }
    }
    if (spawned.stdout && typeof spawned.stdout.on === 'function') spawned.stdout.on('data', keepLine)
    if (spawned.stderr && typeof spawned.stderr.on === 'function') spawned.stderr.on('data', keepLine)
    if (typeof spawned.on === 'function') {
      spawned.on('error', () => {
        /* A failed spawn emits `error` without an `exit` event. Treat it like
           the synchronous throw above or the supervisor would remain marked
           running forever and never retry. Clearing child also makes a
           defensive, later exit event harmless. */
        if (child !== spawned) return
        // A kill/control error from a process that actually started is not
        // evidence of its exit. Keep its identity until an exit is observed.
        if (Number.isInteger(spawned.pid) && spawned.pid > 0) return
        remoteWorkspace.detach()
        child = null
        running = false
        recentLines.length = 0
        if (!stopped) scheduleRestart(REASONS.SPAWN_FAILED)
      })
      spawned.on('exit', (code, signal) => {
        if (child !== spawned) return
        remoteWorkspace.detach()
        child = null
        running = false
        lastExitAt = now()
        if (stopped) { lastReason = REASONS.STOPPED; return }
        const reason = signal
          ? REASONS.SIGNALLED
          : (code === 0 ? REASONS.EXITED_CLEAN : REASONS.EXITED_ERROR)
        /* WHAT IT SAID ON THE WAY OUT. Only on a non-clean exit: a leg that
           stopped because it was asked to has nothing to explain, and printing
           its last forty lines every time would bury the one time it matters. */
        if (reason !== REASONS.EXITED_CLEAN && recentLines.length > 0) {
          log(`the relay leg's last words (${recentLines.length} line(s)):`)
          for (const line of recentLines) log(`  | ${line}`)
        }
        recentLines.length = 0
        if (stopped) {
          lastReason = REASONS.STOPPED
          return
        }
        scheduleRestart(reason)
      })
    }
    return { ok: true }
  }

  /* THE BACKOFF, AND THE ONE PROPERTY THAT MAKES IT USEFUL: a child that lived
     a full minute resets the wait to the floor. Without that, a machine whose
     relay leg is restarted once an hour by something ordinary would drift up
     to a minute of unreachability after a handful of them, for no reason
     anybody could see. */
  function scheduleRestart(reason) {
    if (stopped) return { ok: false, code: REASONS.STOPPED }
    lastReason = reason
    const aliveMs = startedAt ? now() - startedAt : 0
    const delayMs = aliveMs >= STABLE_AFTER_MS ? RESTART_FLOOR_MS : nextDelayMs
    nextDelayMs = Math.min(RESTART_CEILING_MS, delayMs * 2)
    log(`relay leg ${reason}; restarting in ${delayMs}ms`)
    restartTimer = schedule(() => {
      if (stopped) return
      restarts += 1
      launch()
    }, delayMs)
    return { ok: false, code: reason }
  }

  return {
    remoteWorkspace,
    /* Called only when isEnrolled() is true. The caller checks it too -- see
       shell/main.cjs -- but the guarantee is made HERE as well, because "the
       call site remembers" is not a guarantee, and a relay leg started on a
       machine with no pair would sit in a connect-refused loop against an
       account that has never heard of it. */
    start() {
      if (stopFlight || (stopped && child)) return { ok: false, code: REASONS.STOPPING }
      let enrolled = false
      try { enrolled = isEnrolled() === true } catch { enrolled = false }
      if (!enrolled) return refuse(REASONS.NOT_ENROLLED)
      if (!stopped && (child || restartTimer)) return { ok: true, already: true }
      stopped = false
      nextDelayMs = RESTART_FLOOR_MS
      return launch()
    },

    /* This receipt describes the network-owning relay process. Signalling it
       is not observed exit. An unconfirmed stop retains its identity and blocks
       another start; it never becomes a false successful cleanup receipt. */
    stop() {
      stopped = true
      remoteWorkspace.detach()
      if (restartTimer !== null) {
        cancel(restartTimer)
        restartTimer = null
      }
      if (stopFlight) return stopFlight
      const current = child
      if (!current) {
        running = false
        return Promise.resolve({ ok: true, stopped: true })
      }
      if (current.exitCode !== null && current.exitCode !== undefined) {
        running = false
        child = null
        return Promise.resolve({ ok: true, stopped: true })
      }
      if (current.signalCode !== null && current.signalCode !== undefined) {
        running = false
        child = null
        return Promise.resolve({ ok: true, stopped: true })
      }
      stopFlight = new Promise((resolve) => {
        let settled = false
        let escalation = null
        let confirmation = null
        const finish = (observed) => {
          if (settled) return
          settled = true
          if (escalation !== null) cancel(escalation)
          if (confirmation !== null) cancel(confirmation)
          current.removeListener?.('exit', observedExit)
          if (observed) {
            if (child === current) child = null
            running = false
            lastReason = REASONS.STOPPED
          } else {
            lastReason = REASONS.STOP_UNCONFIRMED
          }
          resolve({ ok: observed, stopped: observed, ...(observed ? {} : { code: REASONS.STOP_UNCONFIRMED }) })
        }
        const observedExit = () => finish(true)
        escalation = schedule(() => {
          escalation = null
          try { current.kill('SIGKILL') } catch { /* still wait for actual exit */ }
          if (!settled) confirmation = schedule(() => finish(false), STOP_TIMEOUT_MS)
        }, STOP_TIMEOUT_MS)
        if (typeof current.once === 'function') current.once('exit', observedExit)
        try { current.kill() } catch { /* still wait for actual exit */ }
      })
      const currentStop = stopFlight
      currentStop.then(() => { if (stopFlight === currentStop) stopFlight = null })
      return currentStop
    },

    /* Four facts, no identifiers. `lastReason` is a word from REASONS, chosen
       from the exit itself; nothing the child printed is in here, and neither
       is a pair id, a device id, a machine name or a path. */
    status() {
      return {
        running,
        restarts,
        lastExitAt,
        lastReason,
      }
    },
  }
}

module.exports = {
  INHERITED_ENVIRONMENT_KEYS,
  REASONS,
  REASON_VALUES,
  RELAY_ENTRY,
  RESTART_CEILING_MS,
  RESTART_FLOOR_MS,
  STABLE_AFTER_MS,
  STOP_TIMEOUT_MS,
  WEB_DRIVE_ON,
  WEB_DRIVE_PREF_KEY,
  createRelaySupervisor,
  relayChildEnvironment,
  webDriveMayWrite,
}
