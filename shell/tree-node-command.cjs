/* A coordinator-only, local bootstrap for one saved tree node.
 *
 * Commands live under the running application's own per-user data directory:
 *
 *   <userData>/coordinator-commands/{requests,claims,results}
 *
 * This is deliberately outside AGENT-SUPPORT-CHANNEL.  That mailbox keeps its
 * immutable staged/active contract and is never made writable as a side effect
 * of an app command.  A request file alone does nothing: a coordinator must
 * also launch the same installed executable with one opaque request id.  No
 * path, prompt, model, tier, provider thread, or credential crosses argv.
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')

const PROTOCOL = 'toolsenabled.tree-node-command'
const SCHEMA_VERSION = 1
const FRESH_ACTION = 'fresh-start-existing-node'
const SEND_ACTION = 'send-to-bound-node'
const ACTIONS = Object.freeze([FRESH_ACTION, SEND_ACTION])
const ARG_PREFIX = '--toolsenabled-tree-command='
const SPOOL_NAME = 'coordinator-commands'
const MAX_REQUEST_BYTES = 48 * 1024
const MAX_RESULT_BYTES = 8 * 1024
const MAX_MESSAGE_BYTES = 32 * 1024
const MAX_LIFETIME_MS = 24 * 60 * 60 * 1000
const CLOCK_SKEW_MS = 5 * 60 * 1000
const REQUEST_ID = /^tnc-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const BOUNDED_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/

class TreeNodeCommandError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'TreeNodeCommandError'
    this.code = code
  }
}

function fail(code, message) {
  throw new TreeNodeCommandError(code, message)
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value, allowed, required, label) {
  if (!isPlainObject(value)) fail('MC_TREE_COMMAND_SCHEMA_INVALID', `${label} must be an object.`)
  const allowedSet = new Set(allowed)
  if (Object.keys(value).some(key => !allowedSet.has(key))) {
    fail('MC_TREE_COMMAND_SCHEMA_INVALID', `${label} contains an unsupported field.`)
  }
  if (required.some(key => !Object.prototype.hasOwnProperty.call(value, key))) {
    fail('MC_TREE_COMMAND_SCHEMA_INVALID', `${label} is missing a required field.`)
  }
}

function boundedId(value, label, pattern = BOUNDED_ID) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    fail('MC_TREE_COMMAND_SCHEMA_INVALID', `${label} is not a bounded identifier.`)
  }
  return value
}

function parseTime(value, label) {
  if (typeof value !== 'string' || value.length < 20 || value.length > 40) {
    fail('MC_TREE_COMMAND_SCHEMA_INVALID', `${label} must be an RFC3339 timestamp.`)
  }
  const time = Date.parse(value)
  if (!Number.isFinite(time)) fail('MC_TREE_COMMAND_SCHEMA_INVALID', `${label} must be an RFC3339 timestamp.`)
  return time
}

function validateTreeNodeCommandRequest(value, { expectedRequestId = null, now = Date.now() } = {}) {
  const allowed = [
    'protocol', 'schemaVersion', 'requestId', 'action', 'computerId', 'treeId',
    'nodeId', 'expectedSessionId', 'message', 'createdAt', 'expiresAt', 'containsSecretMaterial',
  ]
  const required = [
    'protocol', 'schemaVersion', 'requestId', 'action', 'computerId', 'treeId',
    'nodeId', 'createdAt', 'expiresAt', 'containsSecretMaterial',
  ]
  exactKeys(value, allowed, required, 'Tree-node command')
  if (value.protocol !== PROTOCOL || value.schemaVersion !== SCHEMA_VERSION || !ACTIONS.includes(value.action)) {
    fail('MC_TREE_COMMAND_SCHEMA_INVALID', 'Tree-node command protocol, version, or action is unsupported.')
  }
  const requestId = boundedId(value.requestId, 'requestId', REQUEST_ID)
  if (expectedRequestId !== null && requestId !== expectedRequestId) {
    fail('MC_TREE_COMMAND_REQUEST_MISMATCH', 'The request id does not match its file name.')
  }
  if (value.containsSecretMaterial !== false) {
    fail('MC_TREE_COMMAND_SECRET_MATERIAL_REFUSED', 'Tree-node commands cannot carry secret material.')
  }
  const created = parseTime(value.createdAt, 'createdAt')
  const expires = parseTime(value.expiresAt, 'expiresAt')
  if (created > now + CLOCK_SKEW_MS) fail('MC_TREE_COMMAND_NOT_YET_VALID', 'Tree-node command was created too far in the future.')
  if (expires <= now) fail('MC_TREE_COMMAND_EXPIRED', 'Tree-node command has expired.')
  if (expires <= created || expires - created > MAX_LIFETIME_MS) {
    fail('MC_TREE_COMMAND_SCHEMA_INVALID', 'Tree-node command lifetime is invalid.')
  }
  const expectedSessionId = value.expectedSessionId === undefined || value.expectedSessionId === null
    ? null
    : boundedId(value.expectedSessionId, 'expectedSessionId', SESSION_ID)
  let message = null
  if (value.action === FRESH_ACTION) {
    if (Object.prototype.hasOwnProperty.call(value, 'message')) {
      fail('MC_TREE_COMMAND_SCHEMA_INVALID', 'A clean start cannot carry a first-turn message.')
    }
  } else {
    if (!expectedSessionId) fail('MC_TREE_COMMAND_SCHEMA_INVALID', 'A bound-node send requires the expected session id.')
    if (typeof value.message !== 'string' || !value.message.trim() || value.message.includes('\0')
        || Buffer.byteLength(value.message, 'utf8') > MAX_MESSAGE_BYTES) {
      fail('MC_TREE_COMMAND_SCHEMA_INVALID', 'Bound-node message is empty, invalid, or oversized.')
    }
    message = value.message
  }
  return Object.freeze({
    protocol: PROTOCOL,
    schemaVersion: SCHEMA_VERSION,
    requestId,
    action: value.action,
    computerId: boundedId(value.computerId, 'computerId'),
    treeId: boundedId(value.treeId, 'treeId'),
    nodeId: boundedId(value.nodeId, 'nodeId'),
    expectedSessionId,
    ...(message !== null ? { message } : {}),
    createdAt: new Date(created).toISOString(),
    expiresAt: new Date(expires).toISOString(),
    containsSecretMaterial: false,
  })
}

function argvContainsTreeNodeCommand(argv = process.argv) {
  return Array.isArray(argv) && argv.some(value => typeof value === 'string' && value.startsWith(ARG_PREFIX))
}

/* SWITCHES CHROMIUM ADDS TO A SECOND INSTANCE'S COMMAND LINE, which this
 * process never passed and the exact grammar below must not count.
 *
 * MEASURED 2026-09-02 on Electron 43.3.0 (Windows): the primary's
 * `second-instance` handler received
 *   [exe, "--toolsenabled-tree-command=<id>", "--allow-file-access-from-files"]
 * for a helper launched as exactly [exe, switch]. The grammar compared lengths,
 * saw three where it expected two, and refused with
 * MC_TREE_COMMAND_ARGUMENT_INVALID -- logged to a console nobody watches -- so
 * every coordinator request ever spooled on 1.0.40 was written, never claimed,
 * and never answered. `--original-process-start-time` is the other switch
 * Chromium is documented to append on relaunch paths. Nothing else is
 * forgiven: the list is closed, matched by exact name or `name=`, and an
 * unknown extra argument still refuses. */
const CHROMIUM_INJECTED_SWITCHES = Object.freeze([
  '--allow-file-access-from-files',
  '--original-process-start-time',
])

function isChromiumInjectedSwitch(value) {
  if (typeof value !== 'string') return false
  return CHROMIUM_INJECTED_SWITCHES.some(name => value === name || value.startsWith(`${name}=`))
}

const USER_DATA_SWITCH = /^--user-data-dir=(.*)$/i
const MAX_REASON_CHARS = 512
const MAX_TOKEN_CHARS = 160

/* ONE SHAPE FOR BOTH ENDS OF THE HAND-OFF.
 *
 * A launcher builds its argv from the slot table below
 * (treeNodeCommandLaunchArgv) and the validator parses against the same table
 * (treeNodeCommandRequestIdFromArgv), so the two cannot drift: a token the
 * launcher emits is, by construction, a token the validator admits, and
 * nothing else is.
 *
 * THE DEVELOPMENT ENTRY NAMES AN APPLICATION, NOT ONE FILENAME -- AND A
 * DEVELOPMENT LAUNCH ALSO NAMES A PROFILE.
 *
 * MEASURED 2026-09-03 on the owner's Live tier: nine spooled resume commands
 * were written to %APPDATA%\ToolsEnabled-Live\coordinator-commands\requests and
 * not one was ever claimed. The Live tier runs the development launch form
 *   electron.exe <appDirectory> --user-data-dir=<profile>
 * so a command helper spawned beside it carries
 *   [electron.exe, <appDirectory>, --toolsenabled-tree-command=<id>]
 * while the one permitted entry argument was `__filename`: the main script
 * INSIDE that directory. `developmentEntry` therefore accepts every spelling
 * that names THIS application -- the caller passes Electron's own answers,
 * `__filename` and `app.getAppPath()` -- and `developmentUserDataPath` admits
 * the one profile switch the caller has already resolved.
 *
 * THE RELAYED ARGV IS NOT IN LAUNCH ORDER, AND CARRIES WHAT THE HELPER
 * APPENDED.
 *
 * MEASURED 2026-09-04T08:16Z on the owner's Live instance: a restart spooled
 * by the Controller circle was claimed 1.4 s later and answered
 * MC_TREE_COMMAND_ARGUMENT_INVALID with no reason. MEASURED the same day on
 * Electron 43.3.0 (Windows) with a probe launched exactly the way
 * Start-ToolsEnabled-Live.cmd launches the Live tier: for a helper started as
 *   [electron.exe, <appDir>, --user-data-dir=<profile>, --toolsenabled-tree-command=<id>]
 * the helper's own process.argv is that list, in that order, and the
 * primary's `second-instance` argv for the same helper is
 *   [electron.exe, --user-data-dir=<profile>, --toolsenabled-tree-command=<id>,
 *    --allow-file-access-from-files, <every switch the helper appended to its
 *    own command line before the lock>, <appDir>]
 * Chromium's CommandLine keeps switches ahead of positional arguments and
 * serialises them that way for the single-instance notification; Electron's
 * own documentation for `second-instance` says the order might change and
 * arguments might be appended. The previous grammar compared the relayed
 * argv to the launcher's order slot by slot and refused at index 1, every
 * time, for every development launch of this product -- and in the helper,
 * shell/main.cjs appends the outside-control switches at module scope before
 * it asks for the lock, so those rode along too.
 *
 * So the executable is pinned first (Chromium keeps the program first) and
 * the remaining slots are filled in any order, each at most once; a token
 * that fits no unfilled slot refuses. Switches Chromium adds are dropped by
 * name from a closed list; switches THIS application appends to its own
 * command line are dropped only when the caller names them, which
 * shell/main.cjs does only for the relayed form. That admits exactly the
 * launcher's tokens plus the two lists, and nothing else.
 *
 * NEITHER WIDENS WHAT A COMMAND CAN REACH. A packaged launch offers neither
 * option, so its grammar is exactly what it was and a --user-data-dir beside
 * the command switch still refuses there. In development the profile is chosen
 * by Electron and then fenced by checkFencedDevUserDataDirectory, which runs
 * before this parse and refuses closed outside the owner's own profile; all
 * this adds is that the token must resolve to the profile the caller already
 * has, so a second, conflicting, or two-token (`--user-data-dir <path>`)
 * spelling still refuses. No working path, URL, message, second command
 * switch, or generic Chromium switch may ride along. */
function sameToken(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  if (path.isAbsolute(left) && path.isAbsolute(right)) {
    const a = path.resolve(left)
    const b = path.resolve(right)
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  }
  return left === right
}

function switchNameOf(value) {
  if (typeof value !== 'string' || !value.startsWith('--')) return null
  const equals = value.indexOf('=')
  return equals === -1 ? value : value.slice(0, equals)
}

function normalizeSwitchName(name) {
  return name.startsWith('--') ? name : `--${name}`
}

function launchIdentity({
  executablePath = null,
  developmentEntry = null,
  developmentUserDataPath = null,
  appendedSwitches = [],
} = {}) {
  if (typeof executablePath !== 'string' || executablePath === '') {
    fail('MC_TREE_COMMAND_ARGUMENT_INVALID', 'The launching executable is unknown.')
  }
  const entries = (Array.isArray(developmentEntry) ? developmentEntry : [developmentEntry])
    .filter(value => typeof value === 'string' && value !== '')
  const profile = entries.length > 0 && typeof developmentUserDataPath === 'string' && developmentUserDataPath !== ''
    ? developmentUserDataPath
    : null
  const appended = (Array.isArray(appendedSwitches) ? appendedSwitches : [])
    .filter(value => typeof value === 'string' && value !== '')
    .map(normalizeSwitchName)
  return { executablePath, entries, profile, appended }
}

/* The slot table. Order is the launcher's order: what Start-ToolsEnabled-Live.cmd
   and docs/coordinator-tree-node-command.md spell. `build` gives the token a
   launcher emits; `fits` says whether a token names this slot. */
function treeNodeCommandLaunchSlots(identity) {
  const { executablePath, entries, profile } = launchIdentity(identity)
  const slots = [{
    name: 'executable',
    required: true,
    describe: '<executable>',
    build: () => executablePath,
    fits: value => sameToken(value, executablePath),
  }]
  if (entries.length > 0) {
    slots.push({
      name: 'application',
      required: true,
      describe: '<appDirectory>',
      build: () => entries[0],
      fits: value => entries.some(entry => sameToken(value, entry)),
    })
  }
  /* The profile slot exists only for a development launch, and only when the
     caller has a profile to compare against. It is OPTIONAL: a helper that
     omits it lands in the default profile, where the request simply is not,
     which costs nothing and cannot reach anything. */
  if (profile) {
    slots.push({
      name: 'profile',
      required: false,
      describe: '--user-data-dir=<profile>',
      build: () => `--user-data-dir=${profile}`,
      fits: value => {
        const parsed = typeof value === 'string' ? USER_DATA_SWITCH.exec(value) : null
        return Boolean(parsed) && parsed[1] !== '' && sameToken(parsed[1], profile)
      },
    })
  }
  slots.push({
    name: 'command',
    required: true,
    describe: `${ARG_PREFIX}<id>`,
    build: requestId => `${ARG_PREFIX}${requestId}`,
    fits: value => typeof value === 'string' && value.startsWith(ARG_PREFIX),
  })
  return slots
}

function describeShape(slots) {
  return `[${slots.map(slot => slot.describe).join(', ')}]`
}

/* A token in a sentence: a switch by its name only (a value never travels
   into a result file), a positional argument as itself, bounded. */
function describeToken(value) {
  if (typeof value !== 'string') return String(value)
  const name = switchNameOf(value)
  const shown = name ? (value.length > name.length ? `${name}=<value>` : name) : value
  return shown.length > MAX_TOKEN_CHARS ? `${shown.slice(0, MAX_TOKEN_CHARS)}...` : shown
}

/* THE LAUNCHER'S HALF: the argv a coordinator hands to Electron for one
   request. The application is named ONE way here -- the directory a
   development launch is started with -- because a launcher does not hold two
   spellings; the validator admits both. A packaged launch passes neither
   entry nor profile. */
function treeNodeCommandLaunchArgv({
  executablePath = null,
  developmentEntry = null,
  developmentUserDataPath = null,
  requestId = null,
} = {}) {
  boundedId(requestId, 'requestId', REQUEST_ID)
  const entries = (Array.isArray(developmentEntry) ? developmentEntry : [developmentEntry])
    .filter(value => typeof value === 'string' && value !== '')
  if (entries.length > 1) fail('MC_TREE_COMMAND_ARGUMENT_INVALID', 'A launcher names the application one way.')
  if (entries.length === 0 && typeof developmentUserDataPath === 'string' && developmentUserDataPath !== '') {
    fail('MC_TREE_COMMAND_ARGUMENT_INVALID', 'A packaged launch has no profile switch; name the application directory for a development launch.')
  }
  return treeNodeCommandLaunchSlots({ executablePath, developmentEntry: entries, developmentUserDataPath })
    .map(slot => slot.build(requestId))
}

/* THE VALIDATOR'S HALF. `rawArgv` is either a helper's own process.argv (launch
   order) or what the primary's `second-instance` handler received (Chromium's
   order, with appended switches) -- see the measurement above. */
function treeNodeCommandRequestIdFromArgv(rawArgv = process.argv, {
  executablePath = Array.isArray(rawArgv) ? rawArgv[0] : null,
  developmentEntry = null,
  developmentUserDataPath = null,
  appendedSwitches = [],
} = {}) {
  if (!Array.isArray(rawArgv)) fail('MC_TREE_COMMAND_ARGUMENT_INVALID', 'Process arguments are unavailable.')
  const matches = rawArgv.filter(value => typeof value === 'string' && value.startsWith(ARG_PREFIX))
  if (matches.length === 0) return null
  if (matches.length !== 1) fail('MC_TREE_COMMAND_ARGUMENT_INVALID', 'Exactly one tree-node command argument is allowed.')
  const { appended } = launchIdentity({ executablePath, developmentEntry, developmentUserDataPath, appendedSwitches })
  const forgiven = value => isChromiumInjectedSwitch(value)
    || appended.some(name => value === name || value.startsWith(`${name}=`))
  const argv = rawArgv.filter(value => !forgiven(value))
  const slots = treeNodeCommandLaunchSlots({ executablePath, developmentEntry, developmentUserDataPath })
  const shape = describeShape(slots)
  const [executable, ...free] = slots
  if (argv.length === 0 || !executable.fits(argv[0])) {
    fail('MC_TREE_COMMAND_ARGUMENT_INVALID', `Tree-node command launch argument 0 (${describeToken(argv[0])}) is not this application's executable; the launch shape is ${shape}.`)
  }
  const filled = new Set()
  argv.slice(1).forEach((value, offset) => {
    const slot = free.find(candidate => !filled.has(candidate) && candidate.fits(value))
    if (!slot) {
      const repeated = free.find(candidate => candidate.fits(value))
      fail('MC_TREE_COMMAND_ARGUMENT_INVALID', repeated
        ? `Tree-node command launch argument ${offset + 1} (${describeToken(value)}) repeats the ${repeated.name} argument; the launch shape is ${shape}.`
        : `Tree-node command launch argument ${offset + 1} (${describeToken(value)}) fits no slot of the launch shape ${shape}.`)
    }
    filled.add(slot)
  })
  const missing = free.filter(slot => slot.required && !filled.has(slot))
  if (missing.length > 0) {
    fail('MC_TREE_COMMAND_ARGUMENT_INVALID', `Tree-node command launch is missing its ${missing.map(slot => slot.name).join(' and ')} argument; the launch shape is ${shape}.`)
  }
  return boundedId(matches[0].slice(ARG_PREFIX.length), 'requestId', REQUEST_ID)
}

/* THE ID A REFUSED LAUNCH CAN STILL NAME.
 *
 * No grammar and no trust: this reads one well-formed request id out of argv so
 * that a launch the grammar has refused can write down WHICH request it
 * refused, instead of dying into a detached process's discarded stderr. Nothing
 * is done on the strength of it except publishing a refusal for a request that
 * is already sitting, unclaimed, in this profile's own spool. */
function treeNodeCommandRequestIdCandidateFromArgv(rawArgv = process.argv) {
  if (!Array.isArray(rawArgv)) return null
  const matches = rawArgv.filter(value => typeof value === 'string' && value.startsWith(ARG_PREFIX))
  if (matches.length !== 1) return null
  const candidate = matches[0].slice(ARG_PREFIX.length)
  return REQUEST_ID.test(candidate) ? candidate : null
}

function treeNodeCommandAdditionalData(requestId) {
  if (requestId === null || requestId === undefined) return {}
  return Object.freeze({ treeNodeCommandRequestId: boundedId(requestId, 'requestId', REQUEST_ID) })
}

function treeNodeCommandRequestIdFromAdditionalData(value) {
  if (!isPlainObject(value) || Object.keys(value).length === 0) return null
  exactKeys(value, ['treeNodeCommandRequestId'], ['treeNodeCommandRequestId'], 'Single-instance data')
  return boundedId(value.treeNodeCommandRequestId, 'requestId', REQUEST_ID)
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function samePath(left, right) {
  const a = path.resolve(left)
  const b = path.resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function spoolRootFor(userDataRoot) {
  if (typeof userDataRoot !== 'string' || !path.isAbsolute(userDataRoot)) {
    fail('MC_TREE_COMMAND_USER_DATA_UNAVAILABLE', 'An absolute application userData directory is required.')
  }
  const resolved = path.resolve(userDataRoot)
  if (resolved === path.parse(resolved).root) {
    fail('MC_TREE_COMMAND_PATH_REFUSED', 'The filesystem root cannot be used as application userData.')
  }
  return path.join(resolved, SPOOL_NAME)
}

function lstatNoReparse(target, label) {
  let stat
  try { stat = fs.lstatSync(target) } catch { fail('MC_TREE_COMMAND_PATH_UNAVAILABLE', `${label} is unavailable.`) }
  if (stat.isSymbolicLink()) fail('MC_TREE_COMMAND_REPARSE_POINT_REFUSED', `${label} cannot be a symbolic link or junction.`)
  return stat
}

function assertRealDirectory(target, label) {
  const stat = lstatNoReparse(target, label)
  if (!stat.isDirectory()) fail('MC_TREE_COMMAND_PATH_UNAVAILABLE', `${label} is not a directory.`)
  if (!samePath(fs.realpathSync.native(target), target)) {
    fail('MC_TREE_COMMAND_REPARSE_POINT_REFUSED', `${label} must resolve to itself.`)
  }
  return path.resolve(target)
}

function assertNoReparseBelow(spoolRoot, target) {
  const relative = path.relative(spoolRoot, target)
  if (!inside(spoolRoot, target) || relative === '' || path.isAbsolute(relative)) {
    fail('MC_TREE_COMMAND_PATH_REFUSED', 'Command path escaped the application spool.')
  }
  let cursor = spoolRoot
  for (const segment of relative.split(path.sep)) {
    if (!segment || segment === '.' || segment === '..') fail('MC_TREE_COMMAND_PATH_REFUSED', 'Command path is invalid.')
    cursor = path.join(cursor, segment)
    lstatNoReparse(cursor, 'Command path')
  }
  const realRoot = fs.realpathSync.native(spoolRoot)
  const realTarget = fs.realpathSync.native(target)
  if (!inside(realRoot, realTarget)) fail('MC_TREE_COMMAND_PATH_REFUSED', 'Command path resolved outside the application spool.')
  return realTarget
}

/* ONE INTERPRETER PER PHASE, NOT ONE PER CHECK.
 *
 * MEASURED 2026-09-02 on the installed 1.0.41: a single tree-node command
 * dispatch ran twenty-five separate powershell.exe processes. Grouping the
 * paths took that to nine, which is where this file stood.
 *
 * MEASURED 2026-09-03 on this machine, by wrapping spawnSync around a real
 * write-locate-claim-publish round trip: those nine starts still cost
 * 2.6-2.9 s, synchronously, and the owner host runs inside the Electron main
 * process, so every session in the application stops for all of it. Six of the
 * nine are the off-process dispatch alone, and every one of those lands BEFORE
 * the renderer is asked to start the node. That is the freeze the owner sees
 * when a node starts.
 *
 * MEASURED the same day, same machine, four runs each: powershell.exe
 * -NoProfile that does NOTHING costs 200-240 ms; the same start plus Get-Acl
 * over one path costs 235-277 ms; over four paths, 241-263 ms. The ACL work is
 * free. The interpreter start is the entire bill, and paths added to a call
 * that is already starting cost nothing measurable. So the only number worth
 * cutting is how many times powershell.exe starts, and the way to cut it is to
 * give one start everything a phase needs.
 *
 * One script therefore secures a list and then inspects a list. Every Set-Acl,
 * every Get-Acl, every allowed SID, every refusal, and the order the refusals
 * fire in are what they were; only the process count changes.
 *
 * Each input line is one verb and one path:
 *   S <path>  secure it
 *   D <path>  inspect it, and let a path that cannot be read fail the whole
 *             pass -- which is what every inspected path did before
 *   F <path>  inspect it, but REPORT a path that cannot be read instead of
 *             failing the pass. Only paths folded in ahead of the fs checks
 *             that own them use this. MEASURED 2026-09-03: with these read as
 *             D instead, locating a request id that has no file on disk fails
 *             the pass on Get-Acl and answers MC_TREE_COMMAND_ACL_UNAVAILABLE
 *             -- "could not look" -- where it has always answered
 *             MC_TREE_COMMAND_PATH_UNAVAILABLE, "not there". Those are
 *             different answers and folding a read earlier must not merge
 *             them.
 *
 * The inspector emits one compact JSON object per line rather than a single
 * object, because ConvertTo-Json in Windows PowerShell 5.1 unwraps a
 * one-element array and a per-line answer cannot be confused for one. The
 * `#secured` line in front of them keeps "could not be secured" and "could not
 * be verified" apart now that one process does both: a pass that dies before
 * printing that marker died securing. */
const ACL_PASS_MARKER = '#secured'
const WINDOWS_ACL_PASS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$lines = @([Console]::In.ReadToEnd() -split "\r?\n" | Where-Object { $_.Length -gt 2 })
$secure = @()
$inspect = @()
foreach ($line in $lines) {
  $verb = $line.Substring(0, 1)
  $target = $line.Substring(2)
  if ($verb -eq 'S') { $secure += $target } else { $inspect += ,@($verb, $target) }
}
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$currentSid = $current.Value
$allowed = @($currentSid, 'S-1-5-18', 'S-1-5-32-544')
if ($secure.Count -gt 0) {
  $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  $propagation = [System.Security.AccessControl.PropagationFlags]::None
  $allowType = [System.Security.AccessControl.AccessControlType]::Allow
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner($current)
  foreach ($sidText in $allowed) {
    $sid = New-Object System.Security.Principal.SecurityIdentifier($sidText)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance, $propagation, $allowType)
    [void]$acl.AddAccessRule($rule)
  }
  foreach ($target in $secure) {
    # Set-Acl asks for SeSecurityPrivilege when a second non-elevated process
    # reapplies this already-protected descriptor. Directory.SetAccessControl
    # writes the same owner and DACL without asking to write the SACL, so the
    # securing pass remains both non-elevated and idempotent.
    [System.IO.Directory]::SetAccessControl($target, $acl)
  }
}
[Console]::Out.WriteLine('${ACL_PASS_MARKER}')
$writeMask = [System.Security.AccessControl.FileSystemRights]::Write -bor
  [System.Security.AccessControl.FileSystemRights]::Modify -bor
  [System.Security.AccessControl.FileSystemRights]::FullControl -bor
  [System.Security.AccessControl.FileSystemRights]::Delete -bor
  [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
  [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
  [System.Security.AccessControl.FileSystemRights]::TakeOwnership
foreach ($entry in $inspect) {
  $verb = $entry[0]
  $target = $entry[1]
  $acl = $null
  $unreadable = $false
  try { $acl = Get-Acl -LiteralPath $target }
  catch { if ($verb -eq 'F') { $unreadable = $true } else { throw } }
  if ($unreadable) {
    [Console]::Out.WriteLine('{"ok":false,"unreadable":true,"currentSid":"' + $currentSid + '","ownerIdentity":null,"writableIdentities":[],"refusedIdentities":["UNREADABLE"]}')
  }
  else {
    $bad = @()
    $writers = @()
    foreach ($rule in $acl.Access) {
      if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
      if (($rule.FileSystemRights -band $writeMask) -eq 0) { continue }
      try { $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }
      catch { $sid = 'UNRESOLVED:' + $rule.IdentityReference.Value }
      $writers += $sid
      if ($allowed -notcontains $sid) { $bad += $sid }
    }
    try {
      try { $ownerRef = New-Object System.Security.Principal.SecurityIdentifier($acl.Owner) }
      catch { $ownerRef = New-Object System.Security.Principal.NTAccount($acl.Owner) }
      $owner = $ownerRef.Translate([System.Security.Principal.SecurityIdentifier]).Value
    }
    catch { $owner = 'UNRESOLVED:' + $acl.Owner }
    if ($allowed -notcontains $owner) { $bad += 'OWNER:' + $owner }
    [Console]::Out.WriteLine(([pscustomobject]@{
      ok = ($bad.Count -eq 0)
      currentSid = $currentSid
      ownerIdentity = $owner
      writableIdentities = @($writers | Select-Object -Unique)
      refusedIdentities = @($bad | Select-Object -Unique)
    } | ConvertTo-Json -Compress))
  }
}
`

const ACL_SECURE_FAILED = 'Application spool ACL could not be secured.'
const ACL_VERIFY_FAILED = 'Application spool ACL could not be verified.'
const ACL_ANSWER_INVALID = 'Application spool ACL answer was invalid.'

function aclPassLine(verb, target, message) {
  // A path with a newline in it would split into two lines and be inspected
  // as two different paths. Windows cannot create one; refuse rather than
  // pass it on.
  if (typeof target !== 'string' || !target || /[\r\n]/.test(target)) fail('MC_TREE_COMMAND_ACL_UNAVAILABLE', message)
  return `${verb} ${target}`
}

/* Starts powershell.exe ONCE for a whole phase and answers one verdict per
 * inspected path, in the order the paths were given. */
function runWindowsAclPass({ secure = [], directories = [], files = [] } = {}) {
  const lines = [
    ...secure.map(target => aclPassLine('S', target, ACL_SECURE_FAILED)),
    ...directories.map(target => aclPassLine('D', target, ACL_VERIFY_FAILED)),
    ...files.map(target => aclPassLine('F', target, ACL_VERIFY_FAILED)),
  ]
  if (lines.length === 0) return []
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const encoded = Buffer.from(WINDOWS_ACL_PASS_SCRIPT, 'utf16le').toString('base64')
  const answer = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    input: lines.join('\n'),
    encoding: 'utf8',
    windowsHide: true,
    // The timeout covers the whole pass. It was 7.5 s for one path; a pass is
    // one process start plus a Set-Acl or Get-Acl per path, so this grows with
    // the list rather than staying at a single path's budget.
    timeout: 7_500 + (lines.length * 2_500),
    maxBuffer: 256 * 1024,
  })
  const emitted = String(answer.stdout || '').split(/\r?\n/).filter(line => line.trim().length > 0)
  const secured = emitted[0] === ACL_PASS_MARKER
  // "could not secure" and "could not look" are different answers, and one
  // process now does both jobs, so the marker is what tells them apart.
  if (answer.error || answer.status !== 0) fail('MC_TREE_COMMAND_ACL_UNAVAILABLE', secured ? ACL_VERIFY_FAILED : ACL_SECURE_FAILED)
  if (!secured) fail('MC_TREE_COMMAND_ACL_UNAVAILABLE', ACL_ANSWER_INVALID)
  const reported = emitted.slice(1)
  if (reported.length !== directories.length + files.length) fail('MC_TREE_COMMAND_ACL_UNAVAILABLE', ACL_ANSWER_INVALID)
  return reported.map(line => {
    try { return JSON.parse(line) }
    catch { return fail('MC_TREE_COMMAND_ACL_UNAVAILABLE', ACL_ANSWER_INVALID) }
  })
}

function defaultAclSecurer(target) {
  if (process.platform === 'win32') {
    runWindowsAclPass({ secure: [target] })
    return
  }
  const stat = fs.statSync(target)
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    fail('MC_TREE_COMMAND_ACL_REFUSED', 'Application spool is not owned by the current account.')
  }
  fs.chmodSync(target, 0o700)
}

function defaultAclInspector(target) {
  if (process.platform === 'win32') {
    return defaultAclInspector.batch([target])[0]
  }
  const stat = fs.statSync(target)
  const owned = typeof process.getuid !== 'function' || stat.uid === process.getuid()
  const privateMode = (stat.mode & 0o077) === 0
  return {
    ok: owned && privateMode,
    currentSid: null,
    ownerIdentity: owned ? 'current-uid' : `uid:${stat.uid}`,
    writableIdentities: owned && privateMode ? ['current-uid'] : [],
    refusedIdentities: owned && privateMode ? [] : [owned ? 'group-or-world' : `uid:${stat.uid}`],
  }
}

/* THE BATCH FORMS, which the production paths use. An injected inspector or
 * securer (every test double is one) carries no `batch`, so it keeps being
 * called once per path exactly as before. */
defaultAclSecurer.batch = function secureAll(targets) {
  const list = [...new Set(targets)]
  if (list.length === 0) return
  if (process.platform === 'win32') {
    runWindowsAclPass({ secure: list })
    return
  }
  for (const target of list) defaultAclSecurer(target)
}

defaultAclInspector.batch = function inspectAll(targets) {
  const list = [...targets]
  if (list.length === 0) return []
  if (process.platform !== 'win32') return list.map(target => defaultAclInspector(target))
  // `directories`, not `files`: a path this form cannot read has always failed
  // the whole call rather than being reported, and every caller of `batch` has
  // already run its own reparse-point check.
  return runWindowsAclPass({ directories: list })
}

/* SECURING AND VERIFYING IN THE SAME PROCESS, plus whatever the caller folded
 * in. Only the DEFAULT securer/inspector pair reaches this: an injected one
 * (every test double is one) is still driven one path at a time, in the same
 * order, by the callers below. */
function defaultAclSecureAndInspect(secure, directories, files) {
  if (process.platform !== 'win32') {
    for (const target of secure) defaultAclSecurer(target)
    return [...directories, ...files].map(target => defaultAclInspector(target))
  }
  return runWindowsAclPass({ secure, directories, files })
}

function aclInspectionIsStrict(answer) {
  if (!answer || answer.ok !== true || !Array.isArray(answer.writableIdentities)
      || !Array.isArray(answer.refusedIdentities) || answer.refusedIdentities.length !== 0) return false
  if (typeof answer.currentSid === 'string' && answer.currentSid) {
    const allowed = new Set([answer.currentSid, 'S-1-5-18', 'S-1-5-32-544'])
    return typeof answer.ownerIdentity === 'string' && allowed.has(answer.ownerIdentity)
      && answer.writableIdentities.every(identity => typeof identity === 'string' && allowed.has(identity))
  }
  return answer.ownerIdentity === 'current-uid'
    && answer.writableIdentities.every(identity => identity === 'current-uid')
}

/* THE VERDICT, once the answers are in hand. Split out so a verdict fetched
 * early -- folded into a pass that was starting anyway -- is judged by exactly
 * the same code, at exactly the point its refusal used to fire. */
function assertStrictAclAnswers(answers) {
  for (const answer of answers) {
    /* "could not look" and "not safe" are different answers. A path the pass
       was asked to report on rather than abort for comes back marked, and it
       has to become the unavailable refusal here -- the one a failed Get-Acl
       has always produced -- never the refused one. */
    if (answer && answer.unreadable === true) fail('MC_TREE_COMMAND_ACL_UNAVAILABLE', ACL_VERIFY_FAILED)
    if (!aclInspectionIsStrict(answer)) {
      fail('MC_TREE_COMMAND_ACL_REFUSED', 'Application spool has a writable or owning identity outside the current account, SYSTEM, and Administrators.')
    }
  }
  return answers
}

function assertSafeAcl(target, aclInspector = defaultAclInspector) {
  return assertSafeAclAll([target], aclInspector)[0]
}

/* ONE VERIFICATION FOR A GROUP OF PATHS. Same verdict per path, same refusal
 * codes, one process. A custom inspector without a batch form is still asked
 * once per path, in order, so an injected double sees exactly the calls it
 * saw before. */
function assertSafeAclAll(targets, aclInspector = defaultAclInspector) {
  const list = [...targets]
  if (list.length === 0) return []
  const batch = typeof aclInspector === 'function' && typeof aclInspector.batch === 'function'
    ? aclInspector.batch : null
  let answers
  try { answers = batch ? batch(list) : list.map(target => aclInspector(target)) }
  catch (error) {
    if (error instanceof TreeNodeCommandError) throw error
    fail('MC_TREE_COMMAND_ACL_UNAVAILABLE', ACL_VERIFY_FAILED)
  }
  if (!Array.isArray(answers) || answers.length !== list.length) {
    fail('MC_TREE_COMMAND_ACL_UNAVAILABLE', ACL_VERIFY_FAILED)
  }
  return assertStrictAclAnswers(answers)
}

/* THE SPOOL DIRECTORIES, VERIFIED ONCE PER SHORT WINDOW.
 *
 * One dispatch opens the spool twice (create, then open), and the claim and
 * publish steps re-verify the same three directories again. Re-running Get-Acl
 * on the same four directories five times inside one dispatch proves nothing
 * the first pass did not: weakening them takes Administrator or SYSTEM, the
 * only identities the ACL already allows. The verdict is therefore remembered
 * for a couple of seconds, per directory, and only for the DEFAULT inspector
 * -- an injected one is never memoised, so every test still counts every call.
 *
 * The window is deliberately short rather than the process lifetime: a spool
 * whose ACL is changed between agent starts is still caught on the next one. */
const ACL_DIRECTORY_MEMO_MS = 2_000
const aclDirectoryMemo = new Map()

function assertSafeAclDirectories(directories, aclInspector = defaultAclInspector) {
  if (aclInspector !== defaultAclInspector) return assertSafeAclAll(directories, aclInspector)
  const now = Date.now()
  const stale = []
  for (const directory of directories) {
    const seen = aclDirectoryMemo.get(directory)
    if (!seen || now - seen > ACL_DIRECTORY_MEMO_MS) stale.push(directory)
  }
  const answers = assertSafeAclAll(stale, aclInspector)
  stale.forEach(directory => aclDirectoryMemo.set(directory, now))
  return answers
}

function commandPaths(spoolRoot, requestId) {
  boundedId(requestId, 'requestId', REQUEST_ID)
  return Object.freeze({
    spoolRoot,
    requests: path.join(spoolRoot, 'requests'),
    claims: path.join(spoolRoot, 'claims'),
    results: path.join(spoolRoot, 'results'),
    requestFile: path.join(spoolRoot, 'requests', `${requestId}.request.json`),
    claimFile: path.join(spoolRoot, 'claims', `${requestId}.claim.json`),
    resultFile: path.join(spoolRoot, 'results', `${requestId}.result.json`),
  })
}

/* THE SPOOL'S OWN PASS.
 *
 * `alsoInspect` is handed the spool root and answers with extra paths -- the
 * request file, today -- to inspect in the SAME powershell.exe this call was
 * already going to start. Their verdicts come back UNASSERTED in
 * `extraAnswers`, because the caller owns the order its refusals fire in and
 * folding a check earlier must not let it jump the queue. An injected securer
 * or inspector gets `extraAnswers: null` and the caller inspects those paths
 * itself, one call at a time, exactly as before. */
function treeNodeCommandSpoolPass({
  userDataRoot,
  aclSecurer = defaultAclSecurer,
  aclInspector = defaultAclInspector,
  alsoInspect = null,
} = {}) {
  if (typeof userDataRoot !== 'string' || !userDataRoot.trim() || !path.isAbsolute(userDataRoot)) {
    fail('MC_TREE_COMMAND_USER_DATA_UNAVAILABLE', 'An absolute application userData directory is required.')
  }
  const userData = assertRealDirectory(path.resolve(userDataRoot), 'Application userData')
  const spoolRoot = spoolRootFor(userData)
  try { fs.mkdirSync(spoolRoot, { mode: 0o700 }) }
  catch (error) { if (!error || error.code !== 'EEXIST') throw error }
  const directories = [spoolRoot, path.join(spoolRoot, 'requests'), path.join(spoolRoot, 'claims'), path.join(spoolRoot, 'results')]
  for (const directory of directories) {
    if (directory !== spoolRoot) {
      try { fs.mkdirSync(directory, { mode: 0o700 }) }
      catch (error) { if (!error || error.code !== 'EEXIST') throw error }
    }
    assertRealDirectory(directory, 'Application command spool')
    if (directory !== spoolRoot) assertNoReparseBelow(spoolRoot, directory)
  }
  const layout = Object.freeze({ userDataRoot: userData, ...commandPaths(spoolRoot, 'tnc-00000000-0000-4000-8000-000000000000') })
  const extras = typeof alsoInspect === 'function' ? alsoInspect(spoolRoot) : []
  // Securing is idempotent -- it writes the same protected ACL it wrote a
  // moment ago -- so a group already secured and verified inside the memo
  // window is left alone. One dispatch opens the spool twice and then claims
  // and publishes through it; without this, each of those repeated the same
  // work over the same four directories.
  const memoised = aclInspector === defaultAclInspector && directories.every(directory => {
    const seen = aclDirectoryMemo.get(directory)
    return seen !== undefined && Date.now() - seen <= ACL_DIRECTORY_MEMO_MS
  })
  const pending = memoised ? [] : directories

  if (aclSecurer === defaultAclSecurer && aclInspector === defaultAclInspector) {
    /* ONE process for the whole phase: secure the four directories, verify the
       same four, and verify whatever the caller folded in. When the memo is
       warm only the folded paths are left, which is the same single start the
       caller used to pay for them on its own. */
    let answers
    try { answers = defaultAclSecureAndInspect(pending, pending, extras) }
    catch (error) {
      if (error instanceof TreeNodeCommandError) throw error
      fail('MC_TREE_COMMAND_ACL_UNAVAILABLE', pending.length > 0 ? ACL_SECURE_FAILED : ACL_VERIFY_FAILED)
    }
    assertStrictAclAnswers(answers.slice(0, pending.length))
    if (!memoised) {
      const at = Date.now()
      directories.forEach(directory => aclDirectoryMemo.set(directory, at))
    }
    return { layout, extraAnswers: answers.slice(pending.length) }
  }

  if (!memoised) {
    const secureAll = typeof aclSecurer === 'function' && typeof aclSecurer.batch === 'function'
      ? aclSecurer.batch : null
    try {
      if (secureAll) secureAll(directories)
      else for (const directory of directories) aclSecurer(directory)
    } catch (error) {
      if (error instanceof TreeNodeCommandError) throw error
      fail('MC_TREE_COMMAND_ACL_UNAVAILABLE', ACL_SECURE_FAILED)
    }
    assertSafeAclAll(directories, aclInspector)
    if (aclInspector === defaultAclInspector) {
      const at = Date.now()
      directories.forEach(directory => aclDirectoryMemo.set(directory, at))
    }
  }
  return { layout, extraAnswers: null }
}

function ensureTreeNodeCommandSpool({
  userDataRoot,
  aclSecurer = defaultAclSecurer,
  aclInspector = defaultAclInspector,
} = {}) {
  return treeNodeCommandSpoolPass({ userDataRoot, aclSecurer, aclInspector, alsoInspect: null }).layout
}

function atomicPublish(target, bytes) {
  const directory = path.dirname(target)
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.partial`)
  let fd = null
  try {
    fd = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(fd, bytes)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null
    fs.linkSync(temporary, target)
    fs.unlinkSync(temporary)
  } catch (error) {
    if (fd !== null) { try { fs.closeSync(fd) } catch {} }
    try { fs.unlinkSync(temporary) } catch {}
    if (error && error.code === 'EEXIST') fail('MC_TREE_COMMAND_ALREADY_EXISTS', 'Tree-node command event already exists.')
    throw error
  }
}

function boundedJsonFile(target, maximum, label) {
  const stat = lstatNoReparse(target, label)
  if (!stat.isFile() || stat.size <= 0 || stat.size > maximum) {
    fail('MC_TREE_COMMAND_FILE_INVALID', `${label} is empty, oversized, or not a regular file.`)
  }
  const fd = fs.openSync(target, 'r')
  try {
    const opened = fs.fstatSync(fd)
    if (!opened.isFile() || opened.size !== stat.size) fail('MC_TREE_COMMAND_FILE_CHANGED', `${label} changed while it was opened.`)
    return fs.readFileSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

function parseJson(bytes, label) {
  try { return JSON.parse(bytes.toString('utf8')) } catch { fail('MC_TREE_COMMAND_FILE_INVALID', `${label} is not valid JSON.`) }
}

function locateRequest({
  userDataRoot,
  requestId,
  now = Date.now(),
  aclSecurer = defaultAclSecurer,
  aclInspector = defaultAclInspector,
} = {}) {
  boundedId(requestId, 'requestId', REQUEST_ID)
  /* The request file's ACL rides in the spool's own pass, so locating a
     command costs ONE powershell.exe instead of three. The order the refusals
     fire in is untouched: the directories' verdict first, then the request
     file's reparse-point check, then the request file's verdict. */
  const { layout, extraAnswers } = treeNodeCommandSpoolPass({
    userDataRoot,
    aclSecurer,
    aclInspector,
    alsoInspect: spoolRoot => [commandPaths(spoolRoot, requestId).requestFile],
  })
  const paths = commandPaths(layout.spoolRoot, requestId)
  assertNoReparseBelow(layout.spoolRoot, paths.requestFile)
  if (extraAnswers) assertStrictAclAnswers(extraAnswers)
  else assertSafeAcl(paths.requestFile, aclInspector)
  const bytes = boundedJsonFile(paths.requestFile, MAX_REQUEST_BYTES, 'Tree-node command request')
  const request = validateTreeNodeCommandRequest(parseJson(bytes, 'Tree-node command request'), { expectedRequestId: requestId, now })
  return Object.freeze({
    userDataRoot: layout.userDataRoot,
    ...paths,
    request,
    requestDigest: crypto.createHash('sha256').update(bytes).digest('hex'),
  })
}

function claimTreeNodeCommand(envelope, { now = Date.now(), aclInspector = defaultAclInspector } = {}) {
  if (!envelope || !envelope.request || !envelope.spoolRoot) fail('MC_TREE_COMMAND_SCHEMA_INVALID', 'Command envelope is unavailable.')
  for (const directory of [envelope.requests, envelope.claims, envelope.results]) {
    assertNoReparseBelow(envelope.spoolRoot, directory)
  }
  assertSafeAclDirectories([envelope.requests, envelope.claims, envelope.results], aclInspector)
  if (fs.existsSync(envelope.resultFile)) {
    assertNoReparseBelow(envelope.spoolRoot, envelope.resultFile)
    assertSafeAcl(envelope.resultFile, aclInspector)
    const stored = parseJson(boundedJsonFile(envelope.resultFile, MAX_RESULT_BYTES, 'Tree-node command result'), 'Tree-node command result')
    validateStoredResultForEnvelope(stored, envelope)
    return Object.freeze({ state: 'completed', resultFile: envelope.resultFile })
  }
  const claim = {
    protocol: PROTOCOL,
    schemaVersion: SCHEMA_VERSION,
    requestId: envelope.request.requestId,
    requestDigest: envelope.requestDigest,
    action: envelope.request.action,
    claimedAt: new Date(now).toISOString(),
    containsSecretMaterial: false,
  }
  try {
    atomicPublish(envelope.claimFile, Buffer.from(`${JSON.stringify(claim)}\n`, 'utf8'))
  } catch (error) {
    if (error instanceof TreeNodeCommandError && error.code === 'MC_TREE_COMMAND_ALREADY_EXISTS') {
      return Object.freeze({ state: 'claimed', claimFile: envelope.claimFile })
    }
    throw error
  }
  assertSafeAcl(envelope.claimFile, aclInspector)
  return Object.freeze({ state: 'claimed-now', claimFile: envelope.claimFile })
}

/* THE REASON BESIDE THE CODE. A refusal's code is a bounded identifier; the
   sentence that says what it means is one line, control characters and
   newlines folded to spaces, cut to MAX_REASON_CHARS rather than refused --
   a refusal that cannot be written is the silence this file exists to end.
   Absent (null) is the answer for a success and for a caller with no words. */
function boundedReason(value) {
  if (typeof value !== 'string') return null
  const folded = value.replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim()
  if (folded === '') return null
  return folded.length > MAX_REASON_CHARS ? `${folded.slice(0, MAX_REASON_CHARS - 3)}...` : folded
}

function normalizeRendererResult(value, request) {
  const required = ['requestId', 'ok', 'code', 'nodeId', 'sessionId', 'threadId']
  /* `reason` IS ADMITTED, BOUNDED, AND KEPT ON A REFUSAL -- THIS IS THE ONE
     PLACE THAT DECIDES WHAT "BOUNDED" MEANS.
     The renderer carries a bounded sentence beside a refusal code for the
     in-process caller (shell/main.cjs, resolveLocalTreeCommand); the same
     completion IPC serves a spooled request, and this function used to
     refuse the whole result for the one extra key -- four publish retries,
     then MC_TREE_COMMAND_RESULT_WRITE_FAILED for a result that was correct.
     The stored result's schema admits it as the one optional key
     (RESULT_OPTIONAL_KEYS), so a spooled caller reads why it was refused;
     publishTreeNodeCommandResult below builds that stored copy straight off
     THIS return rather than re-deriving its own -- one boundedReason() call
     for the whole hand-off, so a future change to what counts as bounded
     cannot land in one caller and not the other.

     A commit on this lane (370fd8f) once narrowed this to a four-key return,
     reasoning from a copy of tools/test/tree-command-refusal-reason.test.mjs
     that a same-day cross-lane integration (page2/integration, "Integrate
     the five Page 2 lanes") had already superseded on the branch this one
     merges from: the spawn-drain lane had its own copy of that test pinning
     the old four-key shape, and the reconciled decision -- reaffirmed there
     with the drain lane's own comment and test updated to match -- was that
     the gate KEEPS the reason. 370fd8f fixed a real red test on its own
     branch tip, but by matching the code to a stale test instead of catching
     that the test was the stale side; merging page2/integration here (which
     carries the reconciled test, unchanged from before 370fd8f) turned red
     again for the opposite reason. See tools/test/tree-command-refusal-reason.test.mjs,
     "the spool result gate admits and keeps a bounded renderer reason". */
  exactKeys(value, [...required, 'reason'], required, 'Tree-node command result')
  if (value.requestId !== request.requestId || value.nodeId !== request.nodeId || typeof value.ok !== 'boolean') {
    fail('MC_TREE_COMMAND_RESULT_INVALID', 'Renderer result does not match the claimed request.')
  }
  const code = value.code === null ? null : boundedId(value.code, 'code')
  const sessionId = value.sessionId === null ? null : boundedId(value.sessionId, 'sessionId', SESSION_ID)
  const threadId = value.threadId === null ? null : boundedId(value.threadId, 'threadId', THREAD_ID)
  if (value.ok === true && (!sessionId || code !== null)) {
    fail('MC_TREE_COMMAND_RESULT_INVALID', 'Successful renderer result needs a session and no refusal code.')
  }
  if (value.ok === false && !code) fail('MC_TREE_COMMAND_RESULT_INVALID', 'Failed renderer result needs a refusal code.')
  if (value.reason !== undefined && value.reason !== null && typeof value.reason !== 'string') {
    fail('MC_TREE_COMMAND_RESULT_INVALID', 'A refusal reason must be a sentence.')
  }
  const reason = value.ok === false ? boundedReason(value.reason) : null
  if (value.ok === true && boundedReason(value.reason) !== null) {
    fail('MC_TREE_COMMAND_RESULT_INVALID', 'Successful renderer result carries no refusal reason.')
  }
  return { ok: value.ok, code, sessionId, threadId, reason }
}

const RESULT_KEYS = Object.freeze([
  'protocol', 'schemaVersion', 'requestId', 'requestDigest', 'action', 'ok',
  'code', 'computerId', 'treeId', 'nodeId', 'sessionId', 'threadId',
  'completedAt', 'containsSecretMaterial',
])
/* Present only on a refusal that had words; never required, so every result
   written before 2026-09-04 still validates. */
const RESULT_OPTIONAL_KEYS = Object.freeze(['reason'])
const resultCompletionTimes = new WeakMap()

function resultKeysExact(keys) {
  return RESULT_KEYS.every(key => keys.includes(key))
    && keys.every(key => RESULT_KEYS.includes(key) || RESULT_OPTIONAL_KEYS.includes(key))
}

function validateStoredResultForEnvelope(value, envelope) {
  if (!isPlainObject(value)) fail('MC_TREE_COMMAND_RESULT_INVALID', 'Stored tree-node command result is not an object.')
  const keys = Object.keys(value)
  if (!resultKeysExact(keys)) {
    fail('MC_TREE_COMMAND_RESULT_INVALID', 'Stored tree-node command result schema is not exact.')
  }
  if (value.protocol !== PROTOCOL || value.schemaVersion !== SCHEMA_VERSION
      || value.requestId !== envelope.request.requestId
      || value.requestDigest !== envelope.requestDigest
      || value.action !== envelope.request.action
      || value.computerId !== envelope.request.computerId
      || value.treeId !== envelope.request.treeId
      || value.nodeId !== envelope.request.nodeId
      || value.containsSecretMaterial !== false
      || !Number.isFinite(Date.parse(value.completedAt))) {
    fail('MC_TREE_COMMAND_RESULT_INVALID', 'Stored tree-node command result does not match its request.')
  }
  normalizeRendererResult({
    requestId: value.requestId,
    ok: value.ok,
    code: value.code,
    nodeId: value.nodeId,
    sessionId: value.sessionId,
    threadId: value.threadId,
    ...(Object.prototype.hasOwnProperty.call(value, 'reason') ? { reason: value.reason } : {}),
  }, envelope.request)
  return value
}

function storedResultMatches(value, expected) {
  if (!isPlainObject(value)) return false
  const keys = Object.keys(value)
  if (!resultKeysExact(keys)) return false
  if (!Number.isFinite(Date.parse(value.completedAt))) return false
  return RESULT_KEYS.every(key => value[key] === expected[key])
    && RESULT_OPTIONAL_KEYS.every(key => (value[key] ?? null) === (expected[key] ?? null))
}

function publishTreeNodeCommandResult(envelope, rendererResult, { now = Date.now(), aclInspector = defaultAclInspector } = {}) {
  for (const directory of [envelope.claims, envelope.results]) {
    assertNoReparseBelow(envelope.spoolRoot, directory)
  }
  assertSafeAclDirectories([envelope.claims, envelope.results], aclInspector)
  const normalized = normalizeRendererResult(rendererResult, envelope.request)
  let completedAt = resultCompletionTimes.get(envelope)
  if (!completedAt) {
    completedAt = new Date(now).toISOString()
    resultCompletionTimes.set(envelope, completedAt)
  }
  const result = {
    protocol: PROTOCOL,
    schemaVersion: SCHEMA_VERSION,
    requestId: envelope.request.requestId,
    requestDigest: envelope.requestDigest,
    action: envelope.request.action,
    ok: normalized.ok,
    code: normalized.code,
    ...(normalized.reason !== null ? { reason: normalized.reason } : {}),
    computerId: envelope.request.computerId,
    treeId: envelope.request.treeId,
    nodeId: envelope.request.nodeId,
    sessionId: normalized.sessionId,
    threadId: normalized.threadId,
    completedAt,
    containsSecretMaterial: false,
  }
  const bytes = Buffer.from(`${JSON.stringify(result)}\n`, 'utf8')
  if (bytes.length > MAX_RESULT_BYTES) fail('MC_TREE_COMMAND_RESULT_INVALID', 'Tree-node command result is oversized.')
  if (fs.existsSync(envelope.resultFile)) {
    assertNoReparseBelow(envelope.spoolRoot, envelope.resultFile)
    assertSafeAcl(envelope.resultFile, aclInspector)
    const stored = parseJson(boundedJsonFile(envelope.resultFile, MAX_RESULT_BYTES, 'Tree-node command result'), 'Tree-node command result')
    if (!storedResultMatches(stored, result)) {
      fail('MC_TREE_COMMAND_RESULT_CONFLICT', 'A different immutable result already exists for this request.')
    }
    return Object.freeze(stored)
  }
  try {
    atomicPublish(envelope.resultFile, bytes)
  } catch (error) {
    if (!(error instanceof TreeNodeCommandError) || error.code !== 'MC_TREE_COMMAND_ALREADY_EXISTS') throw error
    /* Another completion raced the hard-link publication. Reopen the winner
       and accept it only when every field and the exact schema match the
       candidate this call had already built. */
    assertNoReparseBelow(envelope.spoolRoot, envelope.resultFile)
    assertSafeAcl(envelope.resultFile, aclInspector)
    const stored = parseJson(boundedJsonFile(envelope.resultFile, MAX_RESULT_BYTES, 'Tree-node command result'), 'Tree-node command result')
    if (!storedResultMatches(stored, result)) {
      fail('MC_TREE_COMMAND_RESULT_CONFLICT', 'A different immutable result won concurrent publication.')
    }
    return Object.freeze(stored)
  }
  assertSafeAcl(envelope.resultFile, aclInspector)
  return Object.freeze(result)
}

/* A LAUNCH THAT CANNOT RUN STILL HAS TO ANSWER.
 *
 * The result file is a coordinator's ONLY channel: the helper is detached with
 * stdio ignored, so a console line or a stderr write is not a report, it is a
 * silence. MEASURED 2026-09-03 on the owner's Live tier: nine resume commands
 * refused at the argv grammar left nine request files and no results at all,
 * and the caller read that as ok.
 *
 * This publishes the same immutable refusal the "no primary instance" path
 * already publishes, and grants nothing on the way: it touches ONE request that
 * is already sitting unclaimed in this profile's own spool, it claims it
 * exactly the way a real consumer would so a live request can never be
 * overwritten, and it writes only a refusal. `published:false` never stands
 * alone: `reason` says which of the three different things happened -- the
 * request could not be located, it was already claimed by a real consumer, or
 * it was already completed -- and a not-located answer carries the locating
 * failure's own code, because "could not look" and "not there" are different
 * answers and this is the one place a caller can still tell them apart. */
function publishTreeNodeCommandLaunchRefusal({
  userDataRoot,
  requestId,
  code,
  /* THE REASON TRAVELS WITH THE CODE. MEASURED 2026-09-04T08:16Z on the
     owner's Live instance: the result file said MC_TREE_COMMAND_ARGUMENT_INVALID
     and nothing else, and the sentence that named the offending argument had
     been thrown away at the call site. One line, bounded, beside the code. */
  reason = null,
  now = Date.now(),
  aclSecurer = defaultAclSecurer,
  aclInspector = defaultAclInspector,
} = {}) {
  boundedId(code, 'code')
  let envelope
  try {
    envelope = locateRequest({ userDataRoot, requestId, now, aclSecurer, aclInspector })
  } catch (error) {
    return Object.freeze({
      published: false,
      reason: 'not-located',
      /* Not relabelled: a failure this protocol does not name gets its own
         answer rather than borrowing a nearby one. */
      locateCode: error instanceof TreeNodeCommandError ? error.code : 'MC_TREE_COMMAND_LOCATE_FAILED',
    })
  }
  const claim = claimTreeNodeCommand(envelope, { now, aclInspector })
  if (claim.state !== 'claimed-now') {
    return Object.freeze({ published: false, reason: claim.state === 'completed' ? 'already-completed' : 'already-claimed' })
  }
  /* THE CLAIM THIS CALL JUST WROTE MUST NOT OUTLIVE THE PUBLISH IT WAS FOR.
   *
   * claimTreeNodeCommand and publishTreeNodeCommandResult are two separate
   * writes with no transaction between them. If the SECOND one throws -- a
   * transient ACL re-verification failure is the realistic case; the
   * runWindowsAclPass comments above measure a powershell.exe pass costing up
   * to a few seconds under load -- this call would otherwise leave behind
   * exactly what claimTreeNodeCommand's own contract says never happens: a
   * claim with no result to answer it, and no way to try again.
   *
   * A later attempt at this SAME request id -- a coordinator retrying the
   * same printed launch switch (tools/write-tree-node-command.mjs prints it
   * separately from the request precisely so that retry is possible), or
   * simply a real primary instance starting once THIS refusal's own
   * no-primary launch found none -- would call claimTreeNodeCommand and get
   * back `state: 'claimed'`: not completed, so nothing answered it; not
   * `claimed-now`, so nothing may try again either. shell/main.cjs's
   * loadAndClaim turns that into MC_TREE_COMMAND_ALREADY_CLAIMED, and
   * shell/tree-node-command-broker.cjs's pump() drops it silently ("the
   * pump's own catch swallows that silently ... and moves on") -- the
   * request becomes unanswerable forever, by anything, which is worse than
   * the unclaimed launch failure this whole function exists to report.
   *
   * Rolling back only the claim THIS call just created -- never one it found
   * already there, which already returned above -- is safe: nothing else in
   * this process can be racing a claim it has not yet written, and the
   * running application never holds more than one live instance against a
   * profile at a time. See tools/test/tree-node-command.test.mjs, "a refusal
   * whose own publish fails after claiming the request does not leave that
   * claim behind". */
  try {
    publishTreeNodeCommandResult(envelope, {
      requestId: envelope.request.requestId,
      ok: false,
      code,
      nodeId: envelope.request.nodeId,
      sessionId: null,
      threadId: null,
      reason: boundedReason(reason),
    }, { now, aclInspector })
  } catch (error) {
    try { fs.unlinkSync(envelope.claimFile) } catch { /* best-effort: the original error is what the caller needs to see */ }
    throw error
  }
  return Object.freeze({ published: true, code, resultFile: envelope.resultFile })
}

function createTreeNodeCommandRequest({
  userDataRoot,
  action = FRESH_ACTION,
  computerId,
  treeId,
  nodeId,
  expectedSessionId = null,
  message = null,
  lifetimeMs = 30 * 60 * 1000,
  now = Date.now(),
  aclSecurer = defaultAclSecurer,
  aclInspector = defaultAclInspector,
} = {}) {
  if (!Number.isFinite(lifetimeMs) || lifetimeMs <= 0 || lifetimeMs > MAX_LIFETIME_MS) {
    fail('MC_TREE_COMMAND_SCHEMA_INVALID', 'Command lifetime must be positive and no more than 24 hours.')
  }
  const requestId = `tnc-${crypto.randomUUID()}`
  const request = validateTreeNodeCommandRequest({
    protocol: PROTOCOL,
    schemaVersion: SCHEMA_VERSION,
    requestId,
    action,
    computerId,
    treeId,
    nodeId,
    ...(expectedSessionId ? { expectedSessionId } : {}),
    ...(message !== null && message !== undefined ? { message } : {}),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + lifetimeMs).toISOString(),
    containsSecretMaterial: false,
  }, { expectedRequestId: requestId, now })
  const layout = ensureTreeNodeCommandSpool({ userDataRoot, aclSecurer, aclInspector })
  const paths = commandPaths(layout.spoolRoot, requestId)
  const bytes = Buffer.from(`${JSON.stringify(request)}\n`, 'utf8')
  atomicPublish(paths.requestFile, bytes)
  assertSafeAcl(paths.requestFile, aclInspector)
  return Object.freeze({
    ok: true,
    requestId,
    requestFile: paths.requestFile,
    resultFile: paths.resultFile,
    launchArgument: `${ARG_PREFIX}${requestId}`,
    spoolRoot: layout.spoolRoot,
  })
}

module.exports = {
  CHROMIUM_INJECTED_SWITCHES,
  isChromiumInjectedSwitch,
  ACTION: FRESH_ACTION,
  ACTIONS,
  ARG_PREFIX,
  FRESH_ACTION,
  PROTOCOL,
  SCHEMA_VERSION,
  SEND_ACTION,
  TreeNodeCommandError,
  aclInspectionIsStrict,
  argvContainsTreeNodeCommand,
  claimTreeNodeCommand,
  createTreeNodeCommandRequest,
  defaultAclInspector,
  defaultAclSecurer,
  ensureTreeNodeCommandSpool,
  locateRequest,
  normalizeRendererResult,
  publishTreeNodeCommandLaunchRefusal,
  publishTreeNodeCommandResult,
  spoolRootFor,
  treeNodeCommandAdditionalData,
  treeNodeCommandLaunchArgv,
  treeNodeCommandLaunchSlots,
  treeNodeCommandRequestIdCandidateFromArgv,
  treeNodeCommandRequestIdFromAdditionalData,
  treeNodeCommandRequestIdFromArgv,
  validateTreeNodeCommandRequest,
}
