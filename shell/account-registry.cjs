'use strict'

/* THE PERSON'S OWN PROVIDER ACCOUNTS, AS THIS MACHINE ALREADY RECORDS THEM.
 *
 * WHAT IT IS FOR. A person can hold more than one Codex or Claude account -- a
 * school one and a personal one is the ordinary case -- and each account keeps
 * its sign-in in a whole home directory of its own, selected by an environment
 * variable. The engine already reads a list of those homes and rotates between
 * them (capability/src/lib/multi-account/*). Until this file there was NO way to
 * see or edit that list from the application: the only way to add a second
 * account was to hand-write JSON into a directory a customer has no reason to
 * know about. This is the main-process half of the screen that fixes it.
 *
 * IT WRITES THE ENGINE'S FILE, NOT A SECOND ONE. The list lives at
 * <TOOLSENABLED_STATE_ROOT>/config/accounts.json: the identity-bearing
 * capability state root the installed shell gives the engine. machine.json,
 * settings.json and the rotation record remain in the separately resolved
 * per-machine services root. Putting accounts.json beside those records would
 * be two answers to one question -- the rotation would read one file and the
 * screen would show the other -- so there is one registry and this module's
 * rules are the engine's rules, restated:
 *
 *   provider is codex, claude or gemini, and nothing else
 *   a codex entry names profileDir; a claude entry names configDir; a gemini
 *     entry names homeDir
 *   a relative directory resolves against the person's home directory
 *   names are unique PER PROVIDER, so "school" may be both a Codex account
 *     and a Claude account and cannot be two Codex accounts
 *   two accounts of the SAME provider may not share one directory
 *
 * AN ABSENT FILE IS THE NORMAL STATE AND IS NEVER AN ERROR. It means "no
 * rotation": one sign-in on this computer, which is what almost everybody has.
 * The same is true after the last account is removed -- the file is DELETED
 * rather than left holding an empty list, because the engine treats an empty
 * list as a loud refusal (ACCOUNTS_REGISTRY_EMPTY) and absence as the quiet
 * normal state. Writing `{"accounts": []}` would turn "I removed my second
 * account" into "no account is usable", which is the opposite of what happened.
 *
 * WHAT IT MAY NEVER DO, and the rule is structural rather than promised.
 * shell/provider-cli-presence.cjs states this rule for the presence probe; this
 * module is held to it too, and for a harder reason: it is handed the paths of
 * directories that contain real sign-in files. So:
 *
 *   - The ONLY byte-returning call in this file is inside readOwnedBytes(), and
 *     that function refuses, by construction, any path that is not in the
 *     exact product-owned allowlist its caller supplied. It opens one stable
 *     descriptor, proves its file identity matches regular non-link lstat
 *     observations from both sides of the open, and only then reads. A caller
 *     cannot point it at a sign-in file even by mistake, and a path swapped to
 *     a reparse point cannot contribute foreign bytes.
 *   - Whether an account is signed in is decided by ONE lstat and no bytes.
 *     Not the date, not one byte of the contents, and no following of a link.
 *     Two facts come off that stat -- it is a plain file, and it is not empty
 *     -- and both can only ever prove a credential ABSENT; neither is ever
 *     read the other way to claim one is valid. signedInAt() carries the whole
 *     argument, including why this is no longer fs.existsSync (existsSync is a
 *     stat with the error discarded, and the discarded error was "could not
 *     look" being reported as "signed out").
 *   - watchSignIn() watches ONE account's folder, armed by one Sign in press,
 *     and re-runs that same lstat when the sign-in leaf changes. It opens
 *     nothing, reads nothing, and there is only ever one armed at a time.
 *   - Nothing here starts a child process. signInCommand() returns the official
 *     command as TEXT for a person to run themselves; this module never runs it
 *     and never reads what it produces. The sign-in WINDOW a person gets from
 *     the accounts menu is opened by shell/provider-login.cjs, which is handed
 *     the folder this store recorded and nothing else.
 *
 * tools/test/account-registry.test.mjs asserts all three against this source and
 * against an injected file layer, because a rule about credentials that is only
 * written in a comment is not a rule.
 *
 * IT DOES CARRY PATHS TO THE SCREEN, WHICH IS A DELIBERATE EXCEPTION. The
 * presence probe returns no path at all, on the BLOCKER 2 rule. Here the person
 * TYPED the directory, or this store made one for them under a product-owned
 * root: it is their own account being read back to them, and the screen cannot
 * show a list of homes without showing which home. The command they may paste
 * contains it too, and a command with the path left out is not a command.
 * Nothing is discovered and returned -- only what was entered or created here.
 *
 * THE FOLDER A PERSON DOES NOT HAVE TO NAME. The owner's rule for adding an
 * account is "just a few clicks", and a folder path is not a click. So
 * addManaged() makes the folder itself, under <servicesRoot>/account-homes/
 * <provider>/<slug-of-name> -- numbered when that slug is taken or empty --
 * and records it exactly as add() would have recorded a typed one. The person
 * names the account, or does not even do that; the folder is this store's
 * business and is never the reason an add is refused. Nothing is put inside
 * it: the provider's own program writes its sign-in there later, in the
 * person's own terminal window.
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { randomUUID, createHash } = require('node:crypto')

const REGISTRY_LEAF = 'accounts.json'
const STATE_LEAF = 'multi-account-state.json'
const CONFIG_DIRECTORY = 'config'
const HOMES_DIRECTORY = 'account-homes'

const MAX_ACCOUNTS = 24
const MAX_NAME_LENGTH = 64
const MAX_PREVIOUS_NAMES = 64
const MAX_PREVIOUS_NAME_LENGTH = 120
const MAX_DIRECTORY_LENGTH = 1024
const HOME_CREATED_BY_APP_FIELD = 'homeCreatedByApp'

/* A NAME MUST HOLD ONE LETTER OR DIGIT, IN ANY SCRIPT. The folder slug below
   keeps only Latin letters and digits, but a person's name for an account is
   theirs in whatever alphabet they write: a Cyrillic or Chinese name is a
   name, and only a name that is all punctuation ("!!!") is refused. */
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u
const MAX_HISTORY = 20

/* HOW LONG ONE ARMED SIGN-IN WATCH LIVES, AND WHY IT ENDS AT ALL.
 *
 * watchSignIn() is armed by a person pressing Sign in, and what it is waiting
 * for is that person finishing in a browser and a terminal window. Fifteen
 * minutes is generous for that and short enough that a press somebody walked
 * away from does not leave an operating-system handle open for the life of
 * the application. It is a stop, never a poll: nothing re-reads on this
 * timer, it only closes the watch.
 *
 * THE SETTLE. A provider writes its sign-in by creating a temporary file and
 * renaming it over the target, so one sign-in raises several directory
 * events. They are coalesced into one re-probe, because a row that repainted
 * three times would be three answers to one question. */
const SIGN_IN_WATCH_MS = 15 * 60 * 1000
const SIGN_IN_SETTLE_MS = 250

/* WHAT EACH PROVIDER CALLS ITS HOME, WHAT MOVES IT, AND WHAT PROVES A SIGN-IN.
 *
 * Copied field for field from the engine's own table
 * (capability/src/lib/multi-account/registry.js) rather than re-derived, because
 * a screen that wrote `configDir` for a Codex account would produce a file the
 * rotation refuses -- and the person would have no way to tell why.
 *
 * `signInSubdir` IS WHERE THE SIGN-IN FILE SITS INSIDE THE FOLDER, and it is
 * the one fact the engine's table states as code rather than as a field: its
 * signInFilePath() joins `.gemini` for Gemini and nothing for the other two.
 * The Gemini program treats GEMINI_CLI_HOME as a HOME directory and writes its
 * own `.gemini` folder inside it. Verified against gemini-cli's own source
 * rather than assumed: packages/core/src/utils/paths.ts homedir() honours
 * GEMINI_CLI_HOME, and packages/core/src/config/storage.ts
 * getGlobalGeminiDir() is homedir()/.gemini with OAUTH_FILE 'oauth_creds.json'
 * inside it. So the file whose presence means "signed in" is
 * <home>/.gemini/oauth_creds.json, one level down. The first live drive of the
 * menu (2026-09-02) found this store looking one level UP, at
 * <home>/oauth_creds.json, so a signed-in Gemini row would have stayed "not
 * signed in" for ever while the engine's own presence probe called the same
 * folder healthy. The path is composed in exactly one place, signInFilePath()
 * below, with the engine's argument order, and
 * tools/test/account-registry.test.mjs holds it equal to the packed engine's
 * answer for every provider.
 *
 * The commands were MEASURED on this machine, from each program's own help, and
 * not remembered:
 *
 *   codex-cli 0.146.0        `codex --help`      -> `login`      (a top command)
 *   claude 2.1.186           `claude auth --help`-> `auth login` (there is NO
 *                                                  bare `claude login`)
 *   gemini 0.53.0            `gemini --help`     -> no sign-in subcommand at
 *                                                  all; running the program IS
 *                                                  the sign-in, the first time
 *
 * `signInVerb` is the same line shell/provider-login.cjs runs in the window it
 * opens, and tools/test/account-registry.test.mjs holds the two tables equal
 * so the text a person is shown and the command that runs cannot drift.
 */
const PROVIDERS = Object.freeze({
  codex: Object.freeze({
    id: 'codex',
    dirField: 'profileDir',
    homeEnv: 'CODEX_HOME',
    signInFile: 'auth.json',
    signInSubdir: null,
    signInVerb: 'codex login',
  }),
  claude: Object.freeze({
    id: 'claude',
    dirField: 'configDir',
    homeEnv: 'CLAUDE_CONFIG_DIR',
    signInFile: '.credentials.json',
    signInSubdir: null,
    signInVerb: 'claude auth login',
  }),
  gemini: Object.freeze({
    id: 'gemini',
    dirField: 'homeDir',
    homeEnv: 'GEMINI_CLI_HOME',
    signInFile: 'oauth_creds.json',
    signInSubdir: '.gemini',
    signInVerb: 'gemini',
  }),
  grok: Object.freeze({ id: 'grok', dirField: 'configDir', homeEnv: 'GROK_HOME',
    signInFile: 'auth.json', signInSubdir: null, signInVerb: 'grok login' }),
})

const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDERS))

/* THE SIGN-IN FILE OF ONE RESOLVED FOLDER, composed the way the engine's
   registry.signInFilePath(resolvedHome, spec) composes it, with the same
   argument order, so a test can hold the two answers equal. A path and
   nothing more: neither this nor anything that calls it opens the file. */
function signInFilePath(resolvedHome, spec) {
  return spec.signInSubdir
    ? path.join(resolvedHome, spec.signInSubdir, spec.signInFile)
    : path.join(resolvedHome, spec.signInFile)
}


function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function refusal(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function absoluteOwnedRoot(value, code, label) {
  if (!nonEmptyString(value) || !path.isAbsolute(value)) {
    throw refusal(code, `${label} is not an absolute product-owned directory.`)
  }
  const resolved = path.resolve(value)
  if (path.dirname(resolved) === resolved) {
    throw refusal(code, `${label} cannot be the root of a drive.`)
  }
  return resolved
}

/* The engine's registry-location.js resolves this same identity-bearing state
   root. There is deliberately no LOCALAPPDATA, homedir or product-name
   fallback here: a plausible second location is worse than a named refusal. */
function accountsRegistryFile({ stateRoot = process.env.TOOLSENABLED_STATE_ROOT } = {}) {
  return path.join(
    absoluteOwnedRoot(stateRoot, 'ACCOUNT_STATE_ROOT_INVALID', 'The account state root'),
    CONFIG_DIRECTORY,
    REGISTRY_LEAF,
  )
}

/* Rotation history is machine service state, not capability configuration.
   Keeping this explicit prevents a registry move from silently moving the
   switcher's independent state record with it. */
function accountRotationStateFile({ servicesRoot } = {}) {
  return path.join(
    absoluteOwnedRoot(servicesRoot, 'ACCOUNT_SERVICES_ROOT_INVALID', 'The account services root'),
    STATE_LEAF,
  )
}

function bytesOf(value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  if (typeof value === 'string') return Buffer.from(value, 'utf8')
  return null
}

function regularFileIdentity(stat) {
  if (!stat || typeof stat.isFile !== 'function' || !stat.isFile()
    || typeof stat.isSymbolicLink !== 'function' || stat.isSymbolicLink()) return null
  const dev = stat.dev
  const ino = stat.ino
  const numeric = (typeof dev === 'bigint' && typeof ino === 'bigint')
    || (Number.isSafeInteger(dev) && Number.isSafeInteger(ino))
  if (!numeric || ino === 0 || ino === 0n) return null
  return `${String(dev)}:${String(ino)}`
}

/* THE ONLY CALL IN THIS MODULE THAT RETURNS BYTES.
 *
 * Every caller supplies exact derived product-owned paths. No prefix or parent
 * test is used: a sign-in file under an allowed directory is still not an
 * allowed file.
 *
 * Windows Node 22 does not expose O_NOFOLLOW (measured under the exact Dev
 * token), so an lstat followed by a path read would retain a swap window. This
 * instead opens a stable descriptor and performs NO byte read until the
 * regular-file dev+ino identity agrees across: lstat before open, fstat of the
 * opened descriptor, and lstat after open. A swap to another file or a reparse
 * target therefore closes the descriptor and returns null without reading it;
 * a swap after the second lstat cannot redirect the already-open descriptor.
 * Returning null keeps absence/read failure distinct from bytes without ever
 * broadening the fence. */
function readOwnedBytes(target, { allowed, expectedStat = null, fsImpl = fs, independent = false } = {}) {
  if (typeof target !== 'string' || !Array.isArray(allowed) || !allowed.includes(target)) return null
  let descriptor = null
  try {
    const before = expectedStat || fsImpl.lstatSync(target, { bigint: true })
    const beforeIdentity = regularFileIdentity(before)
    if (!beforeIdentity || (independent && before.nlink !== 1n && before.nlink !== 1)) return null
    descriptor = fsImpl.openSync(target, 'r')
    const opened = fsImpl.fstatSync(descriptor, { bigint: true })
    const after = fsImpl.lstatSync(target, { bigint: true })
    if (regularFileIdentity(opened) !== beforeIdentity
      || regularFileIdentity(after) !== beforeIdentity
      || (independent && [opened, after].some(stat => stat.nlink !== 1n && stat.nlink !== 1))) return null
    return bytesOf(fsImpl.readFileSync(descriptor))
  } catch {
    return null
  } finally {
    if (descriptor !== null) {
      try { fsImpl.closeSync(descriptor) } catch { /* a read refusal stays a refusal */ }
    }
  }
}

/* THE POWERSHELL FORM, because Windows Terminal opens PowerShell and this string
   exists to be pasted into it. Single quotes are literal there, which is the
   only quoting that survives a Windows path with backslashes in it; a quote
   inside the path is doubled, the one escape PowerShell has. */
function powerShellLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function inspectOwnedPath(target, fsImpl) {
  try {
    return { stat: fsImpl.lstatSync(target, { bigint: true }), absent: false, error: null }
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return { stat: null, absent: true, error: null }
    }
    return { stat: null, absent: false, error }
  }
}

/* THE SAME THREE ANSWERS, OFF THE MAIN THREAD. See signedInAtAsync() for why
   this exists at all; the classification is copied line for line from
   inspectOwnedPath() above rather than expressed "in terms of" it, so the two
   cannot drift by one of them growing an error code the other does not carry.
   Still one lstat, never a read, exactly like the synchronous form. */
async function inspectOwnedPathAsync(target, fspImpl) {
  try {
    return { stat: await fspImpl.lstat(target, { bigint: true }), absent: false, error: null }
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return { stat: null, absent: true, error: null }
    }
    return { stat: null, absent: false, error }
  }
}

function sameOwnedPath(left, right) {
  const normalize = value => {
    const resolved = path.resolve(value)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  return normalize(left) === normalize(right)
}

/* Validate the legacy bytes against the engine's CURRENT accepted registry
   shape before adopting them. Unknown fields are preserved because the engine
   ignores them; obsolete automatic policy fields are
   also accepted for the same reason. Everything that makes loadRegistry()
   refuse is rejected here, including an empty list. */
function validateEngineRegistryBytes(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    return { ok: false, code: 'ACCOUNT_LEGACY_UNPARSABLE' }
  }
  return validateEngineRegistryRecord(parsed)
}

// The same validation applies to an existing registry and a legacy import.
// Report only an entry's position/name; never echo directory or credential data.
function validateEngineRegistryRecord(parsed) {
  if (!plainObject(parsed) || !Array.isArray(parsed.accounts) || parsed.accounts.length === 0) {
    return { ok: false, code: 'ACCOUNT_LEGACY_INVALID' }
  }

  const seenNamesAndRoles = new Set()
  const seenDirectories = new Set()
  let antigravityRegistered = false
  for (const [index, entry] of parsed.accounts.entries()) {
    const invalid = code => ({ ok: false, code, index,
      name: nonEmptyString(entry?.name) ? entry.name.trim().slice(0, MAX_NAME_LENGTH) : null })
    if (!plainObject(entry) || !nonEmptyString(entry.name) || !nonEmptyString(entry.provider)) {
      return invalid('ACCOUNT_LEGACY_ENTRY_INVALID')
    }
    const spec = Object.hasOwn(PROVIDERS, entry.provider) ? PROVIDERS[entry.provider] : null
    if (!spec) return invalid('ACCOUNT_LEGACY_PROVIDER_UNSUPPORTED')
    if (!nonEmptyString(entry[spec.dirField])) {
      return invalid('ACCOUNT_LEGACY_ENTRY_INVALID')
    }

    if (entry.client != null && (spec.id !== 'gemini' || entry.client !== 'antigravity')) {
      return invalid('ACCOUNT_LEGACY_CLIENT_UNSUPPORTED')
    }
    if (entry.client === 'antigravity') {
      if (antigravityRegistered) return invalid('ACCOUNT_LEGACY_CLIENT_SIGNIN_SHARED')
      antigravityRegistered = true
    }

    const nameKey = `${spec.id}:${entry.name.trim().toLowerCase()}`
    if (seenNamesAndRoles.has(nameKey)) return invalid('ACCOUNT_LEGACY_NAME_DUPLICATE')
    seenNamesAndRoles.add(nameKey)

    if (nonEmptyString(entry.role)) {
      const roleKey = `${spec.id}:role:${entry.role.trim().toLowerCase()}`
      if (seenNamesAndRoles.has(roleKey)) return invalid('ACCOUNT_LEGACY_ROLE_DUPLICATE')
      seenNamesAndRoles.add(roleKey)
    }

    const directoryKey = `${spec.id}:${entry[spec.dirField].trim().toLowerCase()}`
    if (seenDirectories.has(directoryKey)) return invalid('ACCOUNT_LEGACY_DIRECTORY_SHARED')
    seenDirectories.add(directoryKey)
  }
  const labelOwners = new Map()
  for (const entry of parsed.accounts) {
    const aliases = entry.previousNames
    if (aliases != null && (!Array.isArray(aliases) || aliases.length > MAX_PREVIOUS_NAMES
      || aliases.some(label => !nonEmptyString(label) || label.length > MAX_PREVIOUS_NAME_LENGTH))) {
      return { ok: false, code: 'ACCOUNT_LEGACY_ALIASES_INVALID' }
    }
    for (const label of [entry.name, ...(aliases || [])]) {
      const key = `${entry.provider}:${label.trim().toLowerCase()}`
      if (labelOwners.has(key) && labelOwners.get(key) !== entry) return { ok: false, code: 'ACCOUNT_LEGACY_ALIAS_CONFLICT' }
      labelOwners.set(key, entry)
    }
  }
  return { ok: true }
}

function adoptionResult(ok, adopted, legacyRemoved, code) {
  return Object.freeze({ ok, adopted, legacyRemoved, code })
}

/* One narrow compatibility bridge for the old app-owned location.
 *
 * Only <servicesRoot>/accounts.json may be adopted, and only when the canonical
 * target is absent. No machine/settings/rotation file travels with it. The
 * source must be a regular non-link file containing a non-empty registry the
 * current engine accepts. Exact source bytes are published with a same-folder
 * hard link so an existing target can never be overwritten, then re-read and
 * compared. The ignored legacy name is intentionally retained: ordinary Node
 * APIs cannot prove that a pathname still names the inspected file at unlink,
 * and deleting it is not required for adoption. Reset names and sweeps it. */
function adoptLegacyAccountRegistry({
  stateRoot = process.env.TOOLSENABLED_STATE_ROOT,
  servicesRoot,
  fsImpl = fs,
  uniqueId = randomUUID,
} = {}) {
  let target
  let services
  try {
    target = accountsRegistryFile({ stateRoot })
    services = absoluteOwnedRoot(servicesRoot, 'ACCOUNT_SERVICES_ROOT_INVALID', 'The account services root')
  } catch (error) {
    return adoptionResult(false, false, false, error && error.code ? error.code : 'ACCOUNT_LEGACY_ROOT_INVALID')
  }
  const source = path.join(services, REGISTRY_LEAF)
  if (sameOwnedPath(source, target)) {
    return adoptionResult(false, false, false, 'ACCOUNT_LEGACY_PATH_COLLISION')
  }

  /* Existing means existing -- file, directory or reparse point. This check is
     deliberately before inspecting or reading the source. */
  const targetBefore = inspectOwnedPath(target, fsImpl)
  if (targetBefore.error) return adoptionResult(false, false, false, 'ACCOUNT_TARGET_UNREADABLE')
  if (!targetBefore.absent) return adoptionResult(true, false, false, 'ACCOUNT_TARGET_EXISTS')

  const sourceBefore = inspectOwnedPath(source, fsImpl)
  if (sourceBefore.error) return adoptionResult(false, false, false, 'ACCOUNT_LEGACY_UNREADABLE')
  if (sourceBefore.absent) return adoptionResult(true, false, false, 'ACCOUNT_LEGACY_ABSENT')
  if (!sourceBefore.stat.isFile() || sourceBefore.stat.isSymbolicLink()) {
    return adoptionResult(false, false, false, 'ACCOUNT_LEGACY_NOT_REGULAR')
  }

  const sourceBytes = readOwnedBytes(source, {
    allowed: [source],
    expectedStat: sourceBefore.stat,
    fsImpl,
  })
  if (!sourceBytes) return adoptionResult(false, false, false, 'ACCOUNT_LEGACY_UNREADABLE')
  const validation = validateEngineRegistryBytes(sourceBytes)
  if (!validation.ok) return adoptionResult(false, false, false, validation.code)

  const configDirectory = path.dirname(target)
  try {
    fsImpl.mkdirSync(configDirectory, { recursive: true })
  } catch {
    return adoptionResult(false, false, false, 'ACCOUNT_TARGET_DIRECTORY_UNWRITABLE')
  }
  const configInspection = inspectOwnedPath(configDirectory, fsImpl)
  if (configInspection.error || configInspection.absent
    || !configInspection.stat.isDirectory() || configInspection.stat.isSymbolicLink()) {
    return adoptionResult(false, false, false, 'ACCOUNT_TARGET_DIRECTORY_NOT_REGULAR')
  }

  /* Close the source-validation race before creating even a temporary file. */
  const targetAgain = inspectOwnedPath(target, fsImpl)
  if (targetAgain.error) return adoptionResult(false, false, false, 'ACCOUNT_TARGET_UNREADABLE')
  if (!targetAgain.absent) return adoptionResult(true, false, false, 'ACCOUNT_TARGET_EXISTS')

  let token
  try {
    token = uniqueId()
  } catch {
    return adoptionResult(false, false, false, 'ACCOUNT_TEMP_NAME_UNAVAILABLE')
  }
  if (typeof token !== 'string' || !/^[A-Za-z0-9-]{8,128}$/.test(token)) {
    return adoptionResult(false, false, false, 'ACCOUNT_TEMP_NAME_INVALID')
  }
  const temporary = path.join(configDirectory, `.${REGISTRY_LEAF}.${token}.tmp`)

  let published = false
  try {
    fsImpl.writeFileSync(temporary, sourceBytes, { flag: 'wx', mode: 0o600 })
    const tempInspection = inspectOwnedPath(temporary, fsImpl)
    if (tempInspection.error || tempInspection.absent
      || !tempInspection.stat.isFile() || tempInspection.stat.isSymbolicLink()) {
      return adoptionResult(false, false, false, 'ACCOUNT_TEMP_NOT_REGULAR')
    }
    const tempBytes = readOwnedBytes(temporary, {
      allowed: [temporary],
      expectedStat: tempInspection.stat,
      fsImpl,
    })
    if (!tempBytes || !tempBytes.equals(sourceBytes)) {
      return adoptionResult(false, false, false, 'ACCOUNT_TEMP_VERIFY_FAILED')
    }
    try {
      fsImpl.linkSync(temporary, target)
      published = true
    } catch (error) {
      if (error && error.code === 'EEXIST') {
        return adoptionResult(true, false, false, 'ACCOUNT_TARGET_RACED')
      }
      return adoptionResult(false, false, false, 'ACCOUNT_TARGET_PUBLISH_FAILED')
    }

    const targetInspection = inspectOwnedPath(target, fsImpl)
    if (targetInspection.error || targetInspection.absent
      || !targetInspection.stat.isFile() || targetInspection.stat.isSymbolicLink()) {
      return adoptionResult(false, false, false, 'ACCOUNT_TARGET_VERIFY_FAILED')
    }
    const targetBytes = readOwnedBytes(target, {
      allowed: [target],
      expectedStat: targetInspection.stat,
      fsImpl,
    })
    if (!targetBytes || !targetBytes.equals(sourceBytes)) {
      return adoptionResult(false, false, false, 'ACCOUNT_TARGET_VERIFY_FAILED')
    }
  } catch {
    return adoptionResult(false, false, false, published
      ? 'ACCOUNT_TARGET_VERIFY_FAILED'
      : 'ACCOUNT_TEMP_WRITE_FAILED')
  } finally {
    try { fsImpl.unlinkSync(temporary) } catch { /* absent, linked target remains, or best-effort cleanup */ }
  }

  return adoptionResult(true, true, false, 'ACCOUNT_LEGACY_ADOPTED_SOURCE_RETAINED')
}

/* `servicesRoot` is where addManaged() puts the folders it makes. It is the
   same per-machine services root the rotation record lives in, handed in by
   the caller rather than derived here for the reason stateFile is: a store
   that guessed a second location would be a second answer. Without it the
   store still lists, adds typed folders, switches and records a policy; only
   the folder-making add refuses. */
/* `revokeConfinedCopies(identity, signIn)` reaches the confined copies of a
   sign-in this store destroys: the engine hard-links an account's sign-in into
   every confined agent home it prepares for that account, and nothing reaps
   those homes, so removing the account's own file left the credential working
   under every one of them. The caller hands in the engine's own sweep
   (agent-session-confinement revokeConfinedCopies, bound to
   <servicesRoot>/agent-home) rather than this file restating it. Without it a
   removal behaves exactly as it always has.

   It is handed the sign-in's PATH as well as its identity. Once a confined CLI
   has refreshed, the copies holding the live token are a new file that no
   longer shares this one's identity; the engine finds them by the source each
   confined home records, which is this path. */
function createAccountRegistryStore({ file, stateFile = null, servicesRoot = null, fsImpl = fs, fspImpl = fsp, homedir = os.homedir, platform = process.platform, env = process.env, providerIsolation = null, revokeConfinedCopies = null } = {}) {
  if (typeof file !== 'string' || !file) throw new Error('the account registry store needs its file path')
  const isolated = [env, process.env].some(environment => Object.keys(environment).some(name => name.toUpperCase() === 'TOOLSENABLED_PROVIDER_ISOLATION_ROOT'))
  if (isolated && (!providerIsolation || providerIsolation.PROVIDER_SESSION_ISOLATION_VERSION !== 1 || typeof providerIsolation.isolationContext !== 'function'
    || typeof providerIsolation.assertIsolatedPath !== 'function')) {
    throw refusal('AGENT_PROVIDER_ISOLATION_UNAVAILABLE', 'This copy cannot guard private provider accounts.')
  }
  // Validate at each access: a folder can be replaced after the store opens.
  function privatePath(candidate) {
    if (!isolated) return candidate
    const context = providerIsolation.isolationContext(env, { servicesRoot })
    return providerIsolation.assertIsolatedPath(candidate, context, { field: 'account registry path' })
  }
  function privateRecordPath(candidate) {
    privatePath(candidate)
    if (isolated) {
      try {
        const stat = fsImpl.lstatSync(candidate, { bigint: true })
        if (!stat.isFile() || (stat.nlink !== 1n && stat.nlink !== 1)) {
          throw refusal('AGENT_PROVIDER_ISOLATION_PATH', 'The private account registry must be an independent regular file.')
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    return candidate
  }
  if (isolated) {
    privatePath(file)
    if (stateFile) privatePath(stateFile)
    privatePath(servicesRoot)
  }

  /* Damage and absence are both `null` here; the callers decide what each one
     means, and they decide differently. The byte reader itself remains the
     single credential fence above. */
  function readOwnJson(target) {
    privateRecordPath(target)
    const allowed = stateFile ? [file, stateFile] : [file]
    const raw = readOwnedBytes(target, { allowed, fsImpl, independent: isolated })
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw.toString('utf8'))
      return plainObject(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  function registryFileExists() {
    privatePath(file)
    try {
      return fsImpl.existsSync(file)
    } catch {
      return false
    }
  }

  function stateFileExists() {
    if (!stateFile) return false
    privatePath(stateFile)
    try {
      return fsImpl.existsSync(stateFile)
    } catch {
      return false
    }
  }

  // Preserve damaged bytes and a choose-again condition for every provider.
  // The owned directory protects the gap if writing the replacement fails.
  function unreadableChoiceState() {
    return { activeAccount: null, activeByProvider: null, manualPinByProvider: null,
      selectionRevision: null, selectionUnreadableByProvider: Object.fromEntries(PROVIDER_IDS.map(id => [id, true])),
      lastSwitch: null, history: [] }
  }

  function validSelectionRecord(state) {
    if (!plainObject(state)) return false
    if (state.activeAccount != null && !nonEmptyString(state.activeAccount)) return false
    if (state.selectionRevision != null && typeof state.selectionRevision !== 'string') return false
    if (state.history != null && !Array.isArray(state.history)) return false
    for (const field of ['activeByProvider', 'manualPinByProvider', 'selectionUnreadableByProvider']) {
      const map = state[field]
      if (map == null) continue
      if (!plainObject(map)) return false
      for (const provider of PROVIDER_IDS) {
        const value = map[provider]
        if (value == null) continue
        if (field === 'selectionUnreadableByProvider' ? typeof value !== 'boolean' : !nonEmptyString(value)) return false
      }
    }
    return true
  }

  function readChoiceState() {
    if (!stateFile) return null
    const inspection = inspectOwnedPath(privateRecordPath(stateFile), fsImpl)
    if (inspection.error) throw refusal('ACCOUNT_STATE_UNREADABLE',
      'The saved account selection could not be read. Open Accounts and choose an account before starting again.')
    if (!inspection.absent) {
      const state = readOwnJson(stateFile)
      if (state !== null && validSelectionRecord(state)) return state
      if (quarantineDamagedState() === null) throw refusal('ACCOUNT_STATE_DAMAGED',
        'The saved account selection could not be preserved, so the choice was not changed.')
      return unreadableChoiceState()
    }
    if (typeof fsImpl.readdirSync !== 'function') return null
    try {
      const prefix = `${path.basename(stateFile)}.corrupt-`
      return fsImpl.readdirSync(path.dirname(privatePath(stateFile))).some(name => name.startsWith(prefix))
        ? unreadableChoiceState() : null
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw refusal('ACCOUNT_STATE_UNREADABLE',
        'The saved account selection could not be read. Open Accounts and choose an account before starting again.')
    }
  }

  function quarantineDamagedState() {
    if (!stateFile || !stateFileExists()) return null
    const current = readOwnJson(stateFile)
    if (current !== null && validSelectionRecord(current)) return null
    let directory = null
    let aside
    try {
      directory = fsImpl.mkdtempSync(`${stateFile}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}-`)
      aside = path.join(directory, path.basename(stateFile))
      fsImpl.renameSync(stateFile, aside)
    } catch {
      if (directory) { try { fsImpl.rmdirSync(directory) } catch { /* only our empty directory may be removed */ } }
      return null
    }
    writeStateRecord(unreadableChoiceState())
    return aside
  }

  /* The record as it is on disk, with entries left in the provider's own shape
     so that anything this screen does not understand -- a role, an expected
     email address -- survives an add and a remove untouched. */
  function readRecord() {
    const parsed = readOwnJson(file)
    const validation = validateEngineRegistryRecord(parsed)
    return {
      record: validation.ok ? parsed : null,
      problem: !validation.ok && Number.isSafeInteger(validation.index)
        ? { index: validation.index, name: validation.name } : null,
    }
  }

  function loadRecord() {
    return readRecord().record
  }

  function specFor(provider, client = null) {
    const base = nonEmptyString(provider) && Object.hasOwn(PROVIDERS, provider) ? PROVIDERS[provider] : null
    if (client == null) return base
    return base && provider === 'gemini' && client === 'antigravity'
      ? { ...base, client, homeEnv: 'HOME', signInVerb: 'agy', signInFile: null } : null
  }

  /* A relative directory means "under my home", which is the contract
     config/codex.json and the engine's resolveProfileDir() already share. */
  function resolveHome(directory) {
    if (!nonEmptyString(directory)) return null
    const trimmed = directory.trim()
    if (path.isAbsolute(trimmed)) return privatePath(path.resolve(trimmed))
    let home
    try {
      home = isolated ? providerIsolation.isolationContext(env, { servicesRoot }).userProfile : homedir()
    } catch {
      return null
    }
    if (!nonEmptyString(home)) return null
    return privatePath(path.resolve(path.join(home, trimmed)))
  }

  /* PRESENCE, AND NOTHING ELSE -- IN THREE ANSWERS, WHERE THERE USED TO BE TWO.
   *
   * STILL NOT ONE BYTE. inspectOwnedPath() lstats the path signInFilePath()
   * composes, which is the same metadata call this module already uses on
   * every other path it owns: no open, no descriptor, no read, no date, and
   * no following of a link. Two facts are taken off that stat and they are
   * the only two that can prove a credential is ABSENT -- it is a plain file,
   * and it has bytes in it. Neither is ever used the other way round: the
   * engine's own capability/src/lib/providers/claude-auth-probe.js records
   * why that direction is closed ("Reading a token file can say
   * alive-when-dead OR dead-when-alive"), so only the provider itself may say
   * a sign-in WORKS, and this probe never claims it.
   *
   * WHY IT IS NO LONGER existsSync. existsSync is a stat with the error
   * thrown away, and that error is the whole difference between "there is no
   * sign-in here" and "this computer would not let me look". The old code
   * answered 'no' to both, so a folder that could not be read drew as signed
   * out and the row offered a Sign in press that would open a window over a
   * folder that may already be signed in. shell/provider-cli-presence.cjs's
   * signInPresence() already answers this same question in three words; this
   * was the one sign-in probe in the shell that did not, and merging "could
   * not look" into "not there" is the defect this codebase keeps re-finding.
   *
   * PRESENCE ALONE STILL CANNOT SEE A SIGN-OUT, and this does not pretend
   * otherwise. MEASURED 2026-09-03 on this machine: two Claude homes under
   * account-homes\claude had .credentials.json rewritten from 509 bytes to
   * 281 bytes at 03:35:53Z -- signed out, with the file still there -- and no
   * stat can tell those two sizes apart without reading them, which this
   * module may not do and which the probe above says would answer wrongly in
   * both directions anyway. Only the provider's own verdict settles that
   * (Check allowances, whose signed_out status the menu already draws). What
   * this probe owes is the cases it CAN see, reported as themselves.
   *
   *   'yes'     a plain file with bytes in it, where that program keeps its
   *             sign-in.
   *   'no'      nothing usable is there: absent, or a file holding nothing.
   *             Both mean "not signed in", and a Sign in press is the answer
   *             to both.
   *   'unknown' could not look: the folder does not resolve, the stat failed,
   *             or what sits at that path is not a plain file -- a directory
   *             or a reparse point is somebody else's location and this probe
   *             may not follow one to find out. The menu draws "sign-in not
   *             checked" and offers no press, which is the honest thing to do
   *             with an answer nobody has.
   */
  function signedInAt(spec, resolved) {
    if (!resolved || spec.client === 'antigravity') return 'unknown'
    const found = inspectOwnedPath(privatePath(signInFilePath(resolved, spec)), fsImpl)
    if (found.error) return 'unknown'
    if (found.absent) return 'no'
    if (!found.stat.isFile()) return 'unknown'
    /* `> 0` and not `> 0n`: inspectOwnedPath asks for bigint stats, and a
       relational compare works across BigInt and Number, so an injected file
       layer answering a plain number is read the same way. */
    return found.stat.size > 0 ? 'yes' : 'no'
  }

  /* THE SAME QUESTION, ASKED WITHOUT HOLDING ELECTRON'S MAIN THREAD SHUT.
   *
   * list() -- the shape above -- runs this once per account it shows, and
   * every call was an fsImpl.lstatSync() on Electron's main thread, which is
   * also where every OTHER window's IPC reply and the fleet tree's own timers
   * are served. A screen with several accounts paid several blocking stats in
   * a row for a question the person did not even ask twice.
   *
   * The three-way answer is copied from signedInAt() above rather than routed
   * through it, on purpose: 'yes' / 'no' / 'unknown' is the whole reason this
   * probe exists (the comment above signedInAt() names the defect -- "could
   * not look" folded into "not there" -- as the one this codebase keeps
   * re-finding), and a shared helper that only ONE of the two forms called
   * would leave the other free to drift back into it silently. Same stat,
   * same never-open-the-credential rule, same three answers -- just off the
   * thread that every session shares. */
  async function signedInAtAsync(spec, resolved) {
    if (!resolved || spec.client === 'antigravity') return 'unknown'
    const found = await inspectOwnedPathAsync(privatePath(signInFilePath(resolved, spec)), fspImpl)
    if (found.error) return 'unknown'
    if (found.absent) return 'no'
    if (!found.stat.isFile()) return 'unknown'
    return found.stat.size > 0 ? 'yes' : 'no'
  }

  // Cache coherence, not authentication: no credential bytes are opened. The
  // optional list result binds a reading to this exact ordinary file generation.
  // Walk ancestors before descending even outside disposable-provider isolation.
  async function signInGenerationAtAsync(spec, resolved) {
    const answer = (kind, signedIn = 'unknown', token = null) => ({ signedIn, authGeneration: { kind, token } })
    if (spec.client === 'antigravity') return answer('unsupported')
    if (!resolved) return answer('unavailable')
    const integer = (value, minimum = 0n) => {
      if (typeof value === 'number' && Number.isSafeInteger(value)) value = BigInt(value)
      return typeof value === 'bigint' && value >= minimum ? value.toString() : null
    }
    const identity = stat => {
      const dev = integer(stat.dev), ino = integer(stat.ino, 1n)
      return dev !== null && ino !== null ? [dev, ino] : null
    }
    try {
      const target = privatePath(signInFilePath(resolved, spec))
      if (!path.isAbsolute(target)) return answer('unavailable')
      const ancestors = []
      let cursor = path.parse(target).root
      const parts = path.relative(cursor, target).split(path.sep).filter(Boolean)
      for (const component of parts.slice(0, -1)) {
        cursor = path.join(cursor, component)
        const found = await inspectOwnedPathAsync(cursor, fspImpl)
        if (found.error) return answer('unavailable')
        if (found.absent) return answer('absent', 'no')
        if (found.stat.isSymbolicLink() || !found.stat.isDirectory()) return answer('unavailable')
        const id = identity(found.stat)
        if (!id) return answer('unavailable')
        ancestors.push({ path: cursor, identity: id })
      }
      const found = await inspectOwnedPathAsync(target, fspImpl)
      if (found.error) return answer('unavailable')
      if (found.absent) return answer('absent', 'no')
      if (found.stat.isSymbolicLink() || !found.stat.isFile()) return answer('unavailable')
      const id = identity(found.stat), size = integer(found.stat.size)
      const mtime = integer(found.stat.mtimeNs), ctime = integer(found.stat.ctimeNs)
      if (!id || size === null || mtime === null || ctime === null) return answer('unavailable')
      if (size === '0') return answer('absent', 'no')
      // A folder replaced while the leaf was inspected cannot certify that leaf.
      // Only directory identity matters: unrelated sibling writes change mtime.
      for (const parent of ancestors) {
        const current = await inspectOwnedPathAsync(parent.path, fspImpl)
        if (current.error || current.absent || current.stat.isSymbolicLink() || !current.stat.isDirectory()
          || JSON.stringify(identity(current.stat)) !== JSON.stringify(parent.identity)) return answer('unavailable')
      }
      const currentLeaf = await inspectOwnedPathAsync(target, fspImpl)
      if (currentLeaf.error || currentLeaf.absent || currentLeaf.stat.isSymbolicLink() || !currentLeaf.stat.isFile()
        || JSON.stringify([identity(currentLeaf.stat), integer(currentLeaf.stat.size), integer(currentLeaf.stat.mtimeNs), integer(currentLeaf.stat.ctimeNs)])
          !== JSON.stringify([id, size, mtime, ctime])) return answer('unavailable')
      const canonical = platform === 'win32' ? path.resolve(target).toLowerCase() : path.resolve(target)
      const token = createHash('sha256').update(JSON.stringify([
        1, spec.id, spec.client || null, canonical, ancestors.map(parent => parent.identity), id, size, mtime, ctime,
      ])).digest('hex')
      return answer('file', 'yes', token)
    } catch { return answer('unavailable') }
  }

  /* Project an already validated registry into the screen's account shape.
     readRecord refuses the whole list when the engine cannot use an entry;
     a usable subset must not make that registry appear healthy. */
  function usableEntries(record) {
    if (!record) return []
    const out = []
    record.accounts.forEach((entry, index) => {
      if (!plainObject(entry)) return
      const spec = specFor(entry.provider, entry.client)
      if (!spec) return
      if (!nonEmptyString(entry.name) || !nonEmptyString(entry[spec.dirField])) return
      out.push({
        entry,
        spec,
        name: entry.name.trim(),
        directory: entry[spec.dirField].trim(),

      })
    })
    return out
  }

  function sameDirectory(left, right) {
    if (!left || !right) return false
    return left.toLowerCase() === right.toLowerCase()
  }

  function findEntry(record, spec, cleanName) {
    const wanted = cleanName.toLowerCase()
    return usableEntries(record).find(item => item.spec.id === spec.id
      && item.name.toLowerCase() === wanted) || null
  }

  function writeRecord(record) {
    const temp = privateRecordPath(`${file}.tmp-${process.pid}`)
    fsImpl.mkdirSync(path.dirname(privateRecordPath(file)), { recursive: true })
    fsImpl.writeFileSync(temp, `${JSON.stringify({ accounts: record.accounts.map(entry => Object.fromEntries(['name', 'previousNames', 'provider', 'profileDir', 'configDir', 'homeDir', 'client', 'expectEmail', 'homeCreatedByApp', 'role'].filter(key => Object.hasOwn(entry, key)).map(key => [key, entry[key]]))) }, null, 2)}\n`)
    fsImpl.renameSync(temp, file)
  }

  /* THE FILE AS IT MUST BE BEFORE ANYTHING IS APPENDED TO IT. Damage refuses:
     a list that exists and will not parse is somebody's list, and writing over
     it loses whatever it held. The cap refuses. Both add() and addManaged()
     start here, so a rule one of them gains the other cannot forget. */
  function loadForAppend() {
    const record = loadRecord()
    if (record === null && registryFileExists()) {
      throw refusal('ACCOUNT_REGISTRY_DAMAGED', 'The list of accounts on this computer cannot be read, so nothing was changed.')
    }
    const existing = usableEntries(record)
    if (existing.length >= MAX_ACCOUNTS) {
      throw refusal('ACCOUNT_LIMIT', `This computer already lists ${MAX_ACCOUNTS} accounts.`)
    }
    return { record, existing }
  }

  /* Unique PER PROVIDER, which is the engine's rule and not a softening of
     it: one person's "school" is a real Codex account and a real Claude
     account, and refusing the second would be refusing the ordinary case.
     Answers the refusal rather than throwing it, because the default-name
     search below asks the question many times and only the caller that is
     about to write wants to be stopped by the answer. */
  function collisionOf(existing, spec, cleanName, resolved) {
    if (spec.client === 'antigravity' && existing.some(item => item.spec.client === 'antigravity')) {
      return refusal('ACCOUNT_CLIENT_SHARED_SIGN_IN', 'Antigravity uses one native sign-in for this OS account. Another folder is not another subscription.')
    }
    for (const item of existing) {
      if (item.spec.id !== spec.id) continue
      if ([item.name, ...(item.entry.previousNames || [])].some(label => label.toLowerCase() === cleanName.toLowerCase())) {
        return refusal('ACCOUNT_NAME_TAKEN', 'That name is already used for this kind of account.')
      }
      if (sameDirectory(resolveHome(item.directory), resolved)) {
        return refusal('ACCOUNT_FOLDER_SHARED', 'Another account of this kind already uses that folder.')
      }
    }
    return null
  }

  // Both account additions save the same explicit account record.
  function appendEntry({ record, existing, spec, name, directory, homeCreatedByApp = false }) {
    const previous = record || {}
    const kept = Array.isArray(previous.accounts) ? previous.accounts : []
    writeRecord({
      ...previous,
      accounts: [
        ...kept,
        {
          name,
          provider: spec.id,
          ...(spec.client ? { client: spec.client } : {}),
          [spec.dirField]: directory,
          [HOME_CREATED_BY_APP_FIELD]: homeCreatedByApp === true,

        },
      ],
    })
  }

  /* THE FOLDER NAME AN ACCOUNT NAME BECOMES. Lower-case Latin letters, digits
     and single dashes, and nothing else: a Windows folder name may not carry
     the characters a person might type into a name, and two names that
     differ only in case or spacing must not become two folders side by side.
     The registry keeps the name exactly as typed; only the folder is
     flattened. A name written in another alphabet flattens to nothing, and
     freeFolder() below gives it a numbered folder instead of refusing it. */
  function slugOf(name) {
    return name
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, MAX_NAME_LENGTH)
      .replace(/^-+|-+$/g, '')
  }

  function homesRootFor(spec) {
    if (!nonEmptyString(servicesRoot) || !path.isAbsolute(servicesRoot)) return null
    return privatePath(path.join(path.resolve(servicesRoot), HOMES_DIRECTORY, spec.id))
  }

  /* THE FOLDER A TYPED NAME GETS, found rather than refused. The slug is the
     first choice. When another account of this program already holds that
     folder -- "work account" and "work-account" flatten to one slug -- the
     folder is numbered, "work-account-2", and the person's name stays exactly
     as typed. A name with no Latin letter or digit (Cyrillic, Greek, Chinese,
     Arabic) has no slug and takes the "<provider>-<n>" folder an unnamed add
     would take. Only folders are looked at here: the name was checked as a
     name already, and a folder on disk with no entry is inert and is simply
     used. The list is capped, so the loop is too. */
  function freeFolder(existing, spec, homesRoot, slug) {
    const held = candidate => existing.some(item => item.spec.id === spec.id
      && sameDirectory(resolveHome(item.directory), candidate))
    for (let n = 1; n <= MAX_ACCOUNTS + 1; n += 1) {
      const leaf = slug ? (n === 1 ? slug : `${slug}-${n}`) : `${spec.id}-${n}`
      const candidate = path.join(homesRoot, leaf)
      if (!held(candidate)) return candidate
    }
    return null
  }

  /* WHICH ACCOUNT EACH PROGRAM IS ON, read off the rotation record.
     When the record carries the per-provider map, the keys are all three
     providers, null where the map names nobody, so a reader can index by
     provider without a guard. When it carries NO map -- there is no record,
     or the engine wrote it before the per-provider split and it holds only
     the single `activeAccount` -- the answer is null, not a table of three
     nulls. The difference is load-bearing on screen: the menu falls back to
     the older single name, and to the one row that carries it, only when the
     map is absent; a table of nulls would read as "the map names nobody" and
     hide the account the older record does name. The next switch writes the
     map fresh. */
  function emptyByProvider() {
    const out = {}
    for (const id of PROVIDER_IDS) out[id] = null
    return out
  }

  function readNameMap(value) {
    if (!plainObject(value)) return null
    const out = emptyByProvider()
    for (const id of PROVIDER_IDS) {
      const named = value[id]
      out[id] = nonEmptyString(named) ? named.trim() : null
    }
    return out
  }

  function readByProvider(state) {
    return plainObject(state) ? readNameMap(state.activeByProvider) : null
  }


  function readChosenByProvider(state) {
    if (!plainObject(state)) return null
    const written = readNameMap(state.manualPinByProvider)
    if (written) return written
    if (!Array.isArray(state.history)) return null
    const found = emptyByProvider()
    let any = false
    for (let index = state.history.length - 1; index >= 0; index -= 1) {
      const entry = state.history[index]
      if (!plainObject(entry) || entry.outcome !== 'manual-switch' || !nonEmptyString(entry.account)) continue
      for (const id of PROVIDER_IDS) {
        if (found[id] !== null) continue
        if (typeof entry.provider === 'string' && entry.provider !== id) continue
        found[id] = entry.account.trim()
        any = true
      }
    }
    return any ? found : null
  }

  /* The position of the most recent entry of one kind about one program. The
     history is appended in order, so the positions are what say whether a
     start happened before or after the person chose -- and a start that ran
     BEFORE the choice is no evidence that anything moved off it. */
  function lastIndexOfOutcome(history, provider, outcome) {
    if (!Array.isArray(history)) return -1
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const entry = history[index]
      if (!plainObject(entry) || entry.outcome !== outcome) continue
      if (typeof entry.provider === 'string' && entry.provider !== provider) continue
      return index
    }
    return -1
  }


  function movedOffByProvider(state, chosen) {
    if (!plainObject(state) || !plainObject(chosen)) return null
    const out = emptyByProvider()
    let any = false
    for (const id of PROVIDER_IDS) {
      const want = chosen[id]
      if (!nonEmptyString(want)) continue
      const startAt = lastIndexOfOutcome(state.history, id, 'selected')
      if (startAt < 0) continue
      /* A start recorded before the person chose says nothing about the
         choice. A choice older than every entry still in the window has no
         switch entry left to compare against, and every start in the window
         is after it. */
      if (startAt < lastIndexOfOutcome(state.history, id, 'manual-switch')) continue
      const last = state.history[startAt]
      if (!nonEmptyString(last.account) || last.account.trim() === want) continue
      const attempt = Array.isArray(last.attempts)
        ? last.attempts.find(row => plainObject(row) && row.account === want) || null
        : null
      out[id] = {
        chosen: want,
        using: last.account.trim(),
        at: nonEmptyString(last.at) ? last.at.trim() : null,
        reason: attempt && nonEmptyString(attempt.reason) ? attempt.reason.trim() : null,
      }
      any = true
    }
    return any ? out : null
  }

  /* THE ROTATION RECORD, WRITTEN THE SAME WAY THE REGISTRY IS.
   *
   * It is a SECOND file in a SECOND directory (the per-machine services root,
   * not the capability state root) and it belongs to the engine's switcher,
   * which is why every unknown key that comes off disk is written back
   * untouched. This process only ever changes `activeAccount`,
   * `activeByProvider`, `lastSwitch` and the tail of `history`; a field the
   * engine adds tomorrow survives a switch made from this screen today. */
  function writeStateRecord(record) {
    if (!stateFile) throw refusal('ACCOUNT_STATE_UNAVAILABLE', 'This computer has no place recorded for which account is in use.')
    const temp = privateRecordPath(`${stateFile}.tmp-${process.pid}`)
    fsImpl.mkdirSync(path.dirname(privateRecordPath(stateFile)), { recursive: true })
    fsImpl.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`)
    fsImpl.renameSync(temp, stateFile)
  }







  /* A per-window limit as recorded, or null when the file names none. The
     same bounds the engine's registry.js applies, so a number this store
     accepts is a number that side reads back. */


  /* Removing the last account restores the absent state rather than leaving an
     empty list behind. See the header: an empty list is a refusal in the engine
     and absence is the quiet normal. */
  function forgetRecord() {
    /* `force` makes an already-absent file harmless, but a real removal failure
       must reach the caller. Reporting `removed: true` while the registry is
       still present would make the screen claim an effect that did not occur. */
    fsImpl.rmSync(privatePath(file), { force: true })
  }

  /* Destroy the one file this entry's provider spec names as the sign-in,
     added 2026-09-07. Before this, remove() dropped the registry row and left
     that file exactly where it was -- an account no longer listed as
     registered kept a live, still-usable sign-in (measured on the owner's own
     machine: an undeclared claude-1 home carried an unexpired refresh token
     five days after its access token expired and the registration was gone).
     Uses signInFilePath() -- the same composition list()/signedInAt() already
     use, so a Gemini entry's credential (one level down, in .gemini) is
     destroyed at the right path, not the home root. `force: true` makes an
     account that was registered but never signed in -- no file there at all
     -- the same successful no-op it already is for forgetRecord() above; a
     real removal failure still reaches the caller, unwrapped, exactly as
     forgetRecord()'s does, and BEFORE the registry write below, so a
     credential that could not be destroyed is never silently reported as
     removed. */
  function destroyCredential(entry, spec) {
    // Antigravity owns its native credential store. Removing a registration
    // must not inspect it or claim to sign the provider out.
    if (entry.client === 'antigravity') {
      return { credentialDestroyed: false, nativeSignInPreserved: true, credentialDisposition: 'preserved-native-sign-in' }
    }
    if (entry[HOME_CREATED_BY_APP_FIELD] !== true) {
      return {
        credentialDestroyed: false,
        credentialDisposition: entry[HOME_CREATED_BY_APP_FIELD] === false
          ? 'preserved-existing-home'
          : 'preserved-legacy-unknown-home',
      }
    }
    const resolved = resolveHome(entry[spec.dirField])
    if (!resolved) {
      return { credentialDestroyed: false, credentialDisposition: 'preserved-unresolved-home' }
    }
    const signIn = privatePath(signInFilePath(resolved, spec))
    /* The file's identity, taken BEFORE it is removed: the confined copies are
       other names of this same file, and once this name is gone nothing here
       can say which file that was. One lstat, no bytes -- the rule this module
       already keeps for sign-in files. */
    const identity = typeof revokeConfinedCopies === 'function' ? signInIdentity(signIn) : null
    /* A sign-in is reported deleted only when one was there to delete
       (REVIEW-1050 #13): a folder Accounts made where nobody ever signed in
       has none, and "the sign-in was deleted" would be untrue. */
    const present = identity !== null || signInPresent(signIn)
    fsImpl.rmSync(signIn, { force: true })
    if (!present) return { credentialDestroyed: false, credentialDisposition: 'no-saved-sign-in' }
    if (!identity) return { credentialDestroyed: true }
    /* After the removal, so a copy an agent start linked while this ran (it can
       only link the old file) is reached too. Reported, never thrown: the
       sign-in is already gone, and keeping the registration now would show an
       account whose sign-in is not there. */
    let sweep = null
    try { sweep = revokeConfinedCopies(identity, signIn) } catch { sweep = null }
    const removed = sweep && Number.isInteger(sweep.removed) ? sweep.removed : 0
    const complete = Boolean(sweep) && Array.isArray(sweep.failures) && sweep.failures.length === 0
    return { credentialDestroyed: true, confinedCopiesRemoved: removed, confinedCopiesRevoked: complete }
  }

  function signInPresent(file) {
    try { fsImpl.lstatSync(file); return true } catch { return false }
  }

  function signInIdentity(file) {
    try {
      const info = fsImpl.lstatSync(file, { bigint: true })
      return info.isFile() ? Object.freeze({ dev: info.dev, ino: info.ino }) : null
    } catch { return null }
  }

  function signInCommandFor(spec, directory) {
    if (isolated) {
      throw refusal('ACCOUNT_ISOLATED_SIGN_IN_WINDOW_REQUIRED', 'Use this account’s Sign in button to open its private sign-in window.')
    }
    const resolved = resolveHome(directory)
    if (!resolved) {
      throw refusal('ACCOUNT_HOME_UNKNOWN', 'That folder cannot be resolved on this computer.')
    }
    if (spec.client === 'antigravity') {
      const values = { HOME: resolved, USERPROFILE: resolved, XDG_CONFIG_HOME: path.join(resolved, '.config'),
        XDG_CACHE_HOME: path.join(resolved, '.cache'), XDG_DATA_HOME: path.join(resolved, '.local', 'share') }
      const quote = value => "'" + value.replace(/'/g, "'\"'\"'") + "'"
      return platform === 'win32'
        ? Object.entries(values).map(([name, value]) => `$env:${name}=${powerShellLiteral(value)}; `).join('') + 'agy'
        : Object.entries(values).map(([name, value]) => `${name}=${quote(value)}`).join(' ') + ' agy'
    }
    if (platform === 'win32') return `$env:${spec.homeEnv}=${powerShellLiteral(resolved)}; ${spec.signInVerb}`
    // POSIX shells use a command-local assignment. Single quotes keep spaces,
    // apostrophes and shell metacharacters in the account path literal.
    const literal = "'" + resolved.replace(/'/g, "'\"'\"'") + "'"
    return `${spec.homeEnv}=${literal} ${spec.signInVerb}`
  }

  /* WHERE ONE LISTED ACCOUNT KEEPS ITS SIGN-IN, from the list and only from the
     list. A closure rather than a method because two callers need it -- the
     homeOf() below, which hands the folder to the sign-in window, and
     watchSignIn(), which watches that same folder -- and a folder either of
     them took from its caller instead of from the record would be a folder
     nobody recorded. */
  function resolvedHomeOf({ name, provider } = {}, { allowPreviousNames = false } = {}) {
    const spec = specFor(provider)
    if (!spec) {
      throw refusal('ACCOUNT_PROVIDER_UNSUPPORTED', 'There is no sign-in command for that kind of account.')
    }
    const cleanName = typeof name === 'string' ? name.trim() : ''
    if (!cleanName) throw refusal('ACCOUNT_NAME_MISSING', 'Name the account to sign in.')
    const record = loadRecord()
    if (record === null && registryFileExists()) {
      throw refusal('ACCOUNT_REGISTRY_DAMAGED', 'The list of accounts on this computer cannot be read, so nothing was changed.')
    }
    // Saved conversations may use an earlier registered label. Mutating
    // Accounts actions keep requiring the current label through findEntry().
    const match = record === null ? null : allowPreviousNames ? usableEntries(record).find(item => item.spec.id === spec.id
      && (item.name.toLowerCase() === cleanName.toLowerCase()
        || (Array.isArray(item.entry.previousNames)
          && item.entry.previousNames.some(label => typeof label === 'string' && label.toLowerCase() === cleanName.toLowerCase()))))
      : findEntry(record, spec, cleanName)
    if (!match) throw refusal('ACCOUNT_UNKNOWN', 'That account is not on this computer’s list.')
    const resolved = resolveHome(match.directory)
    if (!resolved) {
      throw refusal('ACCOUNT_HOME_UNKNOWN', 'That folder cannot be resolved on this computer.')
    }
    return { name: match.name, provider: spec.id, spec: match.spec, directory: resolved, homeEnv: match.spec.homeEnv, ...(match.spec.client ? { client: match.spec.client } : {}) }
  }

  /* THE ONE ARMED WATCH, AND THE FACT THAT THERE IS ONLY EVER ONE.
   *
   * A person presses Sign in on ONE row. This holds the watch that press
   * armed, and arming a second replaces the first, so what exists here is
   * bounded at a single operating-system handle no matter how many times
   * anybody presses. That bound is the design and not an optimisation: a
   * watch per account would be a background job nobody started, watching
   * folders nobody asked about, which is the thing this menu refuses
   * everywhere else it comes up (src/account-switcher.js's header states the
   * same rule for the allowance press). */
  let armedSignInWatch = null

  function disarmSignInWatch() {
    if (!armedSignInWatch) return
    const held = armedSignInWatch
    armedSignInWatch = null
    if (held.settle) clearTimeout(held.settle)
    if (held.expiry) clearTimeout(held.expiry)
    /* A close that throws is a handle the operating system already took away.
       Nothing is left to report: the watch is gone either way. */
    try { held.watcher.close() } catch { /* already closed by the platform */ }
  }

  return {
    /* WHAT IS LISTED, WHERE EACH ONE LIVES, AND WHETHER IT HAS BEEN SIGNED IN.
     *
     * `damaged` is the one thing absence and a broken file do not share. Both
     * show no accounts -- a screen must not fail because an optional file is
     * malformed -- but only one of them means the person's list is still there
     * and unreadable, and add() refuses in that case rather than overwrite it. */
    list() {
      const { record, problem } = readRecord()
      const damaged = record === null && registryFileExists()
      const accounts = usableEntries(record)
        .map(item => {
          const resolved = resolveHome(item.directory)
          return {
            name: item.name,
            provider: item.spec.id,
            ...(item.entry.previousNames?.length ? { previousNames: [...item.entry.previousNames] } : {}),
            ...(item.spec.client ? { client: item.spec.client } : {}),
            directory: resolved || item.directory,

            signedIn: signedInAt(item.spec, resolved),
          }
        })
        .sort((a, b) => a.provider.localeCompare(b.provider)
          || a.name.localeCompare(b.name))
      return {
        ok: true,
        accounts,
        damaged,
        ...(damaged && problem ? { problem } : {}),
        /* THE SWITCHING RULE FROM THE SAME READ. One file, read once, so the
           accounts and the rule that orders them are one answer rather than
           two reads that a write landing between them could split. Same shape
           as policy(), so a reader of either sees the same thing. */

      }
    },

    /* THE SAME LIST, WITHOUT THE PER-ACCOUNT BLOCK.
     *
     * MEASURED 2026-09-03 (tools/account-list-signin-probe-bench.mjs), three
     * runs, this machine under its normal agent load, median main-thread
     * block time (the column that stays put when a neighbour's syscall
     * spikes the average -- see the note on measure() in the bench):
     *
     *                list() BEFORE   listAsync() AFTER   ratio
     *   6 accounts   1.76-2.64 ms    1.26-2.15 ms        1.2-1.5x
     *  24 accounts   5.08-5.48 ms    1.94-2.90 ms        1.8-2.6x
     *
     * (this install's own accounts-usage-cache.json holds 6, across claude
     * and codex; 24 is here to show the shape -- list() is N blocking
     * syscalls so its cost climbs with N, and the ratio widening with N in
     * all three runs is that mechanism, not noise.) By running the N stats
     * concurrently on libuv's pool instead of one at a time on the thread
     * every other session shares, the account count stops being a tax on
     * everyone else's window.
     *
     * THE REGISTRY READ STAYS SYNCHRONOUS, DELIBERATELY. loadRecord() writes
     * nothing, but add()/remove()/rename() rename OVER the same file it
     * reads, still fully synchronously -- so an awaited read here could be
     * mid-open when one of those renames lands and fail the rename with the
     * same Windows EPERM shell/durable-file.cjs documents, a real regression
     * this file does not carry today because a synchronous call cannot be
     * interleaved by another handler. The per-account sign-in files carry no
     * such risk: this application is never the one that writes them (the
     * comment on signInCommand() above is the whole reason why), so awaiting
     * THEM has no writer to race. That is the line this function draws: the
     * one read this store itself can invalidate stays synchronous; the reads
     * of files only an external program touches do not. */
    async listAsync({ includeAuthGeneration = false } = {}) {
      const { record, problem } = readRecord()
      const damaged = record === null && registryFileExists()
      const accounts = await Promise.all(usableEntries(record).map(async item => {
        const resolved = resolveHome(item.directory)
        const generation = includeAuthGeneration ? await signInGenerationAtAsync(item.spec, resolved) : null
        return {
          name: item.name,
          provider: item.spec.id,
          ...(item.entry.previousNames?.length ? { previousNames: [...item.entry.previousNames] } : {}),
          ...(item.spec.client ? { client: item.spec.client } : {}),
          directory: resolved || item.directory,

          signedIn: generation ? generation.signedIn : await signedInAtAsync(item.spec, resolved),
          ...(generation ? { authGeneration: generation.authGeneration } : {}),
        }
      }))
      accounts.sort((a, b) => a.provider.localeCompare(b.provider)
        || a.name.localeCompare(b.name))
      return {
        ok: true,
        accounts,
        damaged,
        ...(damaged && problem ? { problem } : {}),

      }
    },

    add({ name, provider, client = null, directory } = {}) {
      const spec = specFor(provider, client)
      if (!spec) {
        throw refusal('ACCOUNT_PROVIDER_UNSUPPORTED', 'That kind of account cannot be added here.')
      }
      const cleanName = typeof name === 'string' ? name.trim().slice(0, MAX_NAME_LENGTH) : ''
      if (!cleanName) throw refusal('ACCOUNT_NAME_MISSING', 'Give the account a name.')
      if (typeof directory !== 'string' || !directory.trim()
        || directory.length > MAX_DIRECTORY_LENGTH || directory.includes('\0')) {
        throw refusal('ACCOUNT_FOLDER_INVALID', 'That folder cannot be used for an account.')
      }
      const cleanDirectory = directory.trim()
      const resolved = resolveHome(cleanDirectory)
      if (!resolved) {
        throw refusal('ACCOUNT_HOME_UNKNOWN', 'That folder cannot be resolved on this computer.')
      }
      const { record, existing } = loadForAppend()
      const collision = collisionOf(existing, spec, cleanName, resolved)
      if (collision) throw collision
      appendEntry({ record, existing, spec, name: cleanName, directory: cleanDirectory,
         homeCreatedByApp: false })
      return { ok: true }
    },

    /* ADD AN ACCOUNT WITHOUT ASKING WHERE TO PUT IT.
     *
     * The owner's rule: "it should just be easy to add them in the app, just a
     * few clicks". A folder path is not a click, so this makes the folder --
     * <servicesRoot>/account-homes/<provider>/<slug-of-name> -- and records it
     * exactly as add() records a typed one, through the same damage, cap and
     * collision checks. The name is optional too: left blank, the account is
     * called <provider>-<n> for the first n that is free.
     *
     * THE FOLDER IS NEVER WHY AN ADD IS REFUSED. A typed name is refused only
     * as a name: another account of the same program already has it, or it
     * holds no letter or digit at all. Its folder is found by freeFolder():
     * the slug, numbered when another account holds that folder, and the
     * "<provider>-<n>" form when the name has no Latin letter or digit to
     * make a slug from. The person keeps the name they typed either way.
     *
     * THE ORDER IS PART OF THE DESIGN. Every refusal is decided before the
     * folder is made, so a refused add leaves no folder behind; and the folder
     * is made before the entry is written, so the list never names a folder
     * that is not there. A folder that already exists with no entry (left by
     * an earlier remove, or by a retry) is inert and is simply used.
     *
     * The folder is EMPTY when this returns. The provider's own program puts
     * the sign-in there later, from the window shell/provider-login.cjs opens
     * with this folder in that program's home variable. */
    addManaged({ provider, name, client = null } = {}) {
      const spec = specFor(provider, client)
      if (!spec) {
        throw refusal('ACCOUNT_PROVIDER_UNSUPPORTED', 'That kind of account cannot be added here.')
      }
      const homesRoot = homesRootFor(spec)
      if (!homesRoot) {
        throw refusal('ACCOUNT_HOMES_UNAVAILABLE', 'This computer has no place recorded for account folders yet.')
      }
      if (name !== undefined && name !== null && typeof name !== 'string') {
        throw refusal('ACCOUNT_NAME_INVALID', 'Use at least one letter or number in the name.')
      }
      const typed = typeof name === 'string' ? name.trim().slice(0, MAX_NAME_LENGTH) : ''
      if (typed.includes('\0') || (typed && !HAS_LETTER_OR_DIGIT.test(typed))) {
        throw refusal('ACCOUNT_NAME_INVALID', 'Use at least one letter or number in the name.')
      }

      const { record, existing } = loadForAppend()
      if (spec.client === 'antigravity' && existing.some(item => item.spec.client === 'antigravity')) {
        throw refusal('ACCOUNT_CLIENT_SHARED_SIGN_IN', 'Antigravity uses one native sign-in for this OS account. Another folder is not another subscription.')
      }

      let cleanName = typed
      let directory = null
      if (typed) {
        /* Checked as a name and only as a name: no folder is named, so only
           the name can collide. The folder is then found free. */
        const taken = collisionOf(existing, spec, cleanName, null)
        if (taken) throw taken
        directory = freeFolder(existing, spec, homesRoot, slugOf(typed))
        if (!directory) throw refusal('ACCOUNT_LIMIT', `This computer already lists ${MAX_ACCOUNTS} accounts.`)
      } else {
        /* The first free number, where "free" means neither the name nor the
           folder it would get is already on the list for this program. The
           list is capped, so the loop is too. */
        for (let n = 1; n <= MAX_ACCOUNTS + 1; n += 1) {
          const candidate = `${spec.id}-${n}`
          const candidateDirectory = path.join(homesRoot, candidate)
          if (collisionOf(existing, spec, candidate, candidateDirectory) === null) {
            cleanName = candidate
            directory = candidateDirectory
            break
          }
        }
        if (!cleanName) throw refusal('ACCOUNT_LIMIT', `This computer already lists ${MAX_ACCOUNTS} accounts.`)
      }

      const collision = collisionOf(existing, spec, cleanName, directory)
      if (collision) throw collision

      /* Record whether this call actually made the home. A pre-existing
         directory belongs to somebody else, even when this add retries against
         a folder left by an earlier registration. The initial absence check is
         only a candidate: mkdirSync(target) is deliberately non-recursive, so
         an EEXIST from a concurrent creator turns the origin into preserved
         external ownership instead of falsely claiming the app made it. */
      const targetPath = privatePath(directory)
      const before = inspectOwnedPath(targetPath, fsImpl)
      if (before.error) {
        throw refusal('ACCOUNT_FOLDER_ORIGIN_UNKNOWN', 'The account folder origin could not be established, so the list was left as it was.')
      }
      let homeCreatedByApp = false
      if (before.absent) {
        try {
          fsImpl.mkdirSync(path.dirname(targetPath), { recursive: true })
          fsImpl.mkdirSync(targetPath, { ...(isolated || spec.client === 'antigravity' ? { mode: 0o700 } : {}) })
          homeCreatedByApp = true
        } catch (error) {
          if (!error || error.code !== 'EEXIST') {
            throw refusal('ACCOUNT_FOLDER_NOT_CREATED', 'The folder for that account could not be created, so the list was left as it was.')
          }
          /* Another writer won the exclusive create. The validation below
             decides whether its directory is safe to retain or refuses it. */
        }
      }
      /* Made, and a real directory: a reparse point where the folder should be
         is somebody else's location, and an entry pointing at it would send a
         sign-in there. */
      const made = inspectOwnedPath(targetPath, fsImpl)
      if (made.error || made.absent || !made.stat.isDirectory() || made.stat.isSymbolicLink()) {
        throw refusal('ACCOUNT_FOLDER_NOT_CREATED', 'The folder for that account could not be created, so the list was left as it was.')
      }

      appendEntry({ record, existing, spec, name: cleanName, directory, homeCreatedByApp })
      return { ok: true, name: cleanName, provider: spec.id, ...(spec.client ? { client: spec.client } : {}), directory,
        homeCreatedByApp }
    },

    /* WHERE ONE LISTED ACCOUNT KEEPS ITS SIGN-IN, for the caller that opens the
       sign-in window. It answers from the list and only from the list: a name
       that is not on it is refused, so a window can never be opened onto a
       folder nobody recorded. The answer carries the provider's home variable
       beside the folder so the caller need not consult a second table. */
    homeOf({ name, provider } = {}, { allowPreviousNames = false } = {}) {
      const account = resolvedHomeOf({ name, provider }, { allowPreviousNames })
      /* `spec` stays inside this module: the caller gets the folder and the
         variable that moves it, which is all a sign-in window needs. */
      return { name: account.name, provider: account.provider, directory: account.directory, homeEnv: account.homeEnv, ...(account.client ? { client: account.client } : {}) }
    },

    /* WATCH ONE ACCOUNT'S SIGN-IN FILE, FOR AS LONG AS ONE SIGN-IN TAKES.
     *
     * THE DEFECT. A person presses Sign in, a terminal window opens, they
     * finish in a browser, and the provider writes its sign-in into that one
     * folder. Nothing in this product noticed: the row kept whatever it said
     * before, and the only way to learn otherwise was to come back and press
     * Check allowances -- a press that starts one short-lived program per
     * account. MEASURED 2026-09-03: two Claude homes were signed out at
     * 03:35:53Z and their rows still drew as signed in, because the only
     * fresh signal on this menu is that press.
     *
     * ONE ACCOUNT, AND ONLY THE ONE THAT WAS PRESSED. The name is looked up
     * on the list (resolvedHomeOf), never taken as a folder from the caller,
     * so a watch can no more be pointed at a stranger's directory than a
     * sign-in window can. Arming replaces whatever was armed before, so this
     * is a single handle and never a poll of every account.
     *
     * THE DIRECTORY IS WATCHED, NOT THE FILE, and that is the whole reason it
     * works. The file usually does not exist yet -- signed out is the case
     * this is armed for -- and a watch cannot be opened on a path that is not
     * there. Providers also write a sign-in by renaming a temporary over the
     * target, and on Windows a watch bound to the old file's identity does
     * not follow that replacement. The containing folder exists in both
     * cases (this store makes it), so the folder is watched and events are
     * filtered to the one leaf name.
     *
     * IT READS NO BYTES AND CARRIES NONE. What the listener is handed is the
     * account's name, its program, and the same three-word answer list()
     * gives: 'yes', 'no' or 'unknown'. Nothing else about the file crosses.
     *
     * A REFUSAL NAMES ITSELF. An unknown account, an unresolvable folder, a
     * copy with no watch to give, or a folder the operating system will not
     * watch each answer their own code; none of them is a silent skip. */
    watchSignIn({ name, provider } = {}, onChange, { settleMs = SIGN_IN_SETTLE_MS, timeoutMs = SIGN_IN_WATCH_MS } = {}) {
      if (typeof onChange !== 'function') {
        throw refusal('ACCOUNT_WATCH_NO_LISTENER', 'Nothing was given to tell when that account signs in.')
      }
      if (typeof fsImpl.watch !== 'function') {
        throw refusal('ACCOUNT_WATCH_UNAVAILABLE', 'This computer cannot watch a folder for a sign-in.')
      }
      const account = resolvedHomeOf({ name, provider })
      if (account.client === 'antigravity') {
        disarmSignInWatch()
        throw refusal('ACCOUNT_NATIVE_CLIENT_STATUS_REQUIRED', 'Use Check allowances to ask Antigravity whether this account is signed in.')
      }
      const target = privatePath(signInFilePath(account.directory, account.spec))
      const folder = path.dirname(target)
      const leaf = path.basename(target).toLowerCase()

      disarmSignInWatch()

      const held = { watcher: null, settle: null, expiry: null }

      /* One re-probe per settle, and it is the SAME probe list() answers with,
         so a row repainted from a watch and a row repainted from a fresh list
         can never disagree. */
      const reprobe = () => {
        held.settle = null
        if (armedSignInWatch !== held) return
        const answer = { name: account.name, provider: account.provider, signedIn: signedInAt(account.spec, account.directory) }
        /* A listener that throws is the caller's fault and must not take the
           watch down with it: the next change still gets reported. */
        try { onChange(answer) } catch { /* the caller's listener, not ours */ }
      }

      const onEvent = (_kind, filename) => {
        if (armedSignInWatch !== held) return
        /* `filename` is absent on some platforms; an event with no name is
           taken rather than dropped, because dropping it would lose the one
           change this watch exists for. When there IS a name, only the sign-in
           leaf counts -- a provider's other bookkeeping in that folder is not
           a sign-in. */
        if (typeof filename === 'string' && filename && path.basename(filename).toLowerCase() !== leaf) return
        if (held.settle) clearTimeout(held.settle)
        held.settle = setTimeout(reprobe, settleMs)
        if (typeof held.settle.unref === 'function') held.settle.unref()
      }

      try {
        held.watcher = fsImpl.watch(folder, { persistent: false }, onEvent)
      } catch {
        throw refusal('ACCOUNT_WATCH_FOLDER_UNREADABLE', 'That account’s folder could not be watched, so its row will not change on its own.')
      }
      /* An error on the handle (the folder was removed while watching) ends
         the watch rather than crashing the process that armed it. */
      if (typeof held.watcher.on === 'function') held.watcher.on('error', () => { disarmSignInWatch() })

      armedSignInWatch = held
      held.expiry = setTimeout(() => { disarmSignInWatch() }, timeoutMs)
      if (typeof held.expiry.unref === 'function') held.expiry.unref()

      return {
        ok: true,
        name: account.name,
        provider: account.provider,
        stop() { if (armedSignInWatch === held) disarmSignInWatch() },
      }
    },

    /* Close whatever is armed. The window that armed it going away is the
       caller this exists for; calling it with nothing armed is an answer, not
       a failure. */
    stopWatchingSignIn() {
      const wasArmed = armedSignInWatch !== null
      disarmSignInWatch()
      return { ok: true, stopped: wasArmed }
    },

    /* RENAME AN ACCOUNT ON THE LIST. The name is the person's label for a
       folder; the folder, its sign-in and its place in the order all stay.
       The rotation record follows the name, so an account in use is still
       the one in use afterwards; a name already used for the same program
       is refused the way add() refuses it. */
    rename({ name, provider, newName } = {}) {
      const spec = specFor(provider)
      if (!spec) throw refusal('ACCOUNT_PROVIDER_UNSUPPORTED', 'That kind of account cannot be renamed here.')
      const cleanName = typeof name === 'string' ? name.trim() : ''
      if (!cleanName) throw refusal('ACCOUNT_NAME_MISSING', 'Name the account to rename.')
      const cleanNew = typeof newName === 'string' ? newName.trim().slice(0, MAX_NAME_LENGTH) : ''
      if (!cleanNew) throw refusal('ACCOUNT_NAME_MISSING', 'Give the account its new name.')

      const record = loadRecord()
      if (record === null) {
        throw refusal(
          registryFileExists() ? 'ACCOUNT_REGISTRY_DAMAGED' : 'ACCOUNT_REGISTRY_ABSENT',
          registryFileExists()
            ? 'The list of accounts on this computer cannot be read, so nothing was changed.'
            : 'There are no accounts on this computer to rename.',
        )
      }
      const match = findEntry(record, spec, cleanName)
      if (!match) throw refusal('ACCOUNT_UNKNOWN', 'That account is not on this computer’s list.')
      if (cleanNew === match.name) return { ok: true, renamed: false, name: match.name }
      if (match.name.length > MAX_PREVIOUS_NAME_LENGTH) throw refusal('ACCOUNT_RENAME_NAME_INVALID',
        'The saved account name is too long to rename safely. Keep its current name so saved conversations can still find it.')
      const conflicting = usableEntries(record).some(item => item.spec.id === spec.id && item.entry !== match.entry
        && [item.name, ...(item.entry.previousNames || [])].some(label => label.toLowerCase() === cleanNew.toLowerCase()))
      if (conflicting) throw refusal('ACCOUNT_NAME_TAKEN', 'That name is already used for this kind of account.')
      const previousNames = [...new Set([...(match.entry.previousNames || []), match.name])]
      if (previousNames.length > MAX_PREVIOUS_NAMES) throw refusal('ACCOUNT_RENAME_HISTORY_FULL',
        'This account has too many saved names to rename safely. Keep its current name so saved conversations can still find it.')

      // Migrate the choice even when another account is active. Promote legacy
      // manual history before rewriting it, preserving the other providers.
      if (stateFile) {
        const state = readChoiceState()
        if (plainObject(state)) {
          const byProvider = readByProvider(state)
          const chosen = readChosenByProvider(state)
          const renameLabel = value => value === match.name ? cleanNew : value
          const aboutProvider = entry => !nonEmptyString(entry?.provider) || entry.provider === spec.id
          const migrateEntry = entry => plainObject(entry) && aboutProvider(entry) ? {
            ...entry,
            ...(Object.hasOwn(entry, 'account') ? { account: renameLabel(entry.account) } : {}),
            ...(Object.hasOwn(entry, 'switchedFrom') ? { switchedFrom: renameLabel(entry.switchedFrom) } : {}),
            ...(Object.hasOwn(entry, 'from') ? { from: renameLabel(entry.from) } : {}),
            ...(Object.hasOwn(entry, 'to') ? { to: renameLabel(entry.to) } : {}),
            ...(Array.isArray(entry.attempts) ? { attempts: entry.attempts.map(attempt => plainObject(attempt)
              ? { ...attempt, account: renameLabel(attempt.account) } : attempt) } : {}),
          } : entry
          const legacyActive = aboutProvider(state.lastSwitch) && state.activeAccount === match.name
          writeStateRecord({
            ...state,
            selectionRevision: randomUUID(),
            ...(legacyActive ? { activeAccount: cleanNew } : {}),
            ...(byProvider ? { activeByProvider: { ...byProvider, [spec.id]: renameLabel(byProvider[spec.id]) } } : {}),
            ...(chosen ? { manualPinByProvider: { ...chosen, [spec.id]: renameLabel(chosen[spec.id]) } } : {}),
            lastSwitch: migrateEntry(state.lastSwitch),
            history: Array.isArray(state.history) ? state.history.map(migrateEntry) : [],
          })
        }
      }
      writeRecord({ ...record, accounts: record.accounts.map(entry => entry === match.entry ? { ...entry, name: cleanNew, previousNames } : entry) })
      return { ok: true, renamed: true, name: cleanNew }
    },

    remove({ name, provider } = {}) {
      const spec = specFor(provider)
      if (!spec) {
        throw refusal('ACCOUNT_PROVIDER_UNSUPPORTED', 'That kind of account cannot be removed here.')
      }
      const cleanName = typeof name === 'string' ? name.trim() : ''
      if (!cleanName) throw refusal('ACCOUNT_NAME_MISSING', 'Name the account to remove.')

      const record = loadRecord()
      if (record === null) {
        if (registryFileExists()) {
          throw refusal('ACCOUNT_REGISTRY_DAMAGED', 'The list of accounts on this computer cannot be read, so nothing was changed.')
        }
        return { ok: true, removed: false }
      }
      const wanted = cleanName.toLowerCase()
      const target = record.accounts.find(entry => plainObject(entry) && entry.provider === spec.id
        && nonEmptyString(entry.name) && entry.name.trim().toLowerCase() === wanted)
      if (!target) return { ok: true, removed: false }

      // The provider credential is touched BEFORE the registry entry is
      // dropped, and only when this app recorded that it made the home.
      const credential = destroyCredential(target, spec)

      const next = record.accounts.filter(entry => entry !== target)
      if (next.length === 0) forgetRecord()
      else writeRecord({ ...record, accounts: next })
      return { ok: true, removed: true, ...credential }
    },

    /* WHICH ACCOUNT EACH PROGRAM IS ON, AND WHICH ONE WAS SWITCHED TO LAST.
     *
     * `byProvider` is the answer the screen should draw from: one name per
     * program ({ codex, claude, gemini }, null where the map names nobody),
     * read off the record's `activeByProvider` -- and null, not a table, when
     * the record carries no map at all, so the screen knows to fall back to
     * the older single name below. `name` is the legacy single
     * `activeAccount` -- the last switch made on this machine, whichever
     * program it was for -- kept for readers that predate the split, and
     * `provider` says which program that last switch was for when the record
     * says so. Every field is optional, every failure is "not known", and this
     * never throws: a screen must not go blank because an optional record is
     * missing or malformed. */
    activeAccount() {
      const empty = {
        name: null, provider: null, at: null, byProvider: null, lastSwitch: null,
        chosenByProvider: null, movedOffByProvider: null,
      }
      if (!stateFile) return empty
      let state
      try { state = readChoiceState() } catch { return { ...empty, code: 'ACCOUNT_STATE_UNREADABLE',
        reason: 'The saved account selection could not be read. Open Accounts and choose an account before starting again.' } }
      if (!state) return empty
      const chooseAgain = Object.values(state.selectionUnreadableByProvider || {}).some(value => value === true)
      const name = nonEmptyString(state.activeAccount) ? state.activeAccount.trim() : null
      const lastSwitch = plainObject(state.lastSwitch) ? state.lastSwitch : null
      const at = lastSwitch && nonEmptyString(lastSwitch.at) ? lastSwitch.at.trim() : null
      const byProvider = readByProvider(state)
      let provider = lastSwitch && specFor(nonEmptyString(lastSwitch.provider) ? lastSwitch.provider.trim() : null)
        ? lastSwitch.provider.trim()
        : null
      if (provider === null && name !== null) {
        /* A record the engine wrote names no provider on the switch. When
           exactly one program's entry carries that name the answer is not in
           doubt; when two do, it is, and null is the honest answer. */
        const holders = byProvider ? PROVIDER_IDS.filter(id => byProvider[id] === name) : []
        provider = holders.length === 1 ? holders[0] : null
      }

      const lastSwitchOut = lastSwitch === null ? null : {
        at,
        from: nonEmptyString(lastSwitch.from) ? lastSwitch.from.trim().slice(0, 64) : null,
        to: nonEmptyString(lastSwitch.to) ? lastSwitch.to.trim().slice(0, 64) : null,
        provider: specFor(nonEmptyString(lastSwitch.provider) ? lastSwitch.provider.trim() : null)
          ? lastSwitch.provider.trim()
          : null,
        automatic: typeof lastSwitch.automatic === 'boolean' ? lastSwitch.automatic : null,
        /* The switcher's own sentence for why. Bounded because it is written by
           another program and shown to a person. */
        reason: nonEmptyString(lastSwitch.reason) ? lastSwitch.reason.trim().slice(0, 240) : null,
      }
      const chosenByProvider = readChosenByProvider(state)
      return {
        name, provider, at, byProvider,
        ...(chooseAgain ? { code: 'ACCOUNT_STATE_UNREADABLE',
          reason: 'The saved account selection could not be read. Open Accounts and choose an account before starting again.' } : {}),
        lastSwitch: lastSwitchOut,
        /* The choice and its consequence travel together: "which account did I
           pick" is only half an answer while the computer is running another
           one and nothing says so. Both are null when the record has nothing
           to say, which is different from a table saying nobody chose. */
        chosenByProvider,
        movedOffByProvider: movedOffByProvider(state, chosenByProvider),
      }
    },

    /* SWITCH THIS COMPUTER ONTO ONE OF THE LISTED ACCOUNTS, BY NAME.
     *
     * WHAT IT DOES NOT DO, and the omission is the point. It does not probe the
     * account, and it does not sign anything in. The engine's own switchTo()
     * verifies a target before committing to it, and it is right to: a manual
     * switch onto a dead account just moves the failure somewhere less obvious.
     * But that verification spawns a provider process, and this file is held by
     * tools/test/account-registry.test.mjs to starting NO child process at all.
     * So the check happens where the probing already happens: the next start
     * re-checks the chosen account and stops on a refusal, as it
     * would have anyway. Recording a preference can never be the step that runs
     * an agent as an account that cannot serve.
     *
     * ONE ACTIVE NAME PER PROGRAM. The record carries `activeByProvider`
     * ({ codex, claude, gemini }) beside the legacy `activeAccount`, which is
     * kept as the last switch made for readers that predate the split. The
     * comparison and the write are both per provider: a Codex "school" in use
     * does not make a Claude "school" read as already chosen, and choosing one
     * program's account leaves the other programs' choices alone. A record
     * with no per-provider entry yet is always written, because a single
     * legacy name says nothing about which program it was for.
     *
     * A DAMAGED RECORD IS REFUSED, NOT REPLACED. readOwnJson() answers null for
     * an absent file and for one that will not parse, and only the first may
     * be written fresh. Writing over the second would throw away the engine's
     * history and every key it held, silently, from a press on a menu.
     *
     * The name must be on the list. Writing an unknown name would leave the
     * next start preferring an account the registry cannot resolve, which the
     * selection walk would silently ignore -- a switch that appeared to work
     * and did nothing. */
    switchTo({ name, provider } = {}) {
      const spec = specFor(provider)
      if (!spec) throw refusal('ACCOUNT_PROVIDER_UNSUPPORTED', 'That kind of account cannot be switched to here.')
      const cleanName = typeof name === 'string' ? name.trim() : ''
      if (!cleanName) throw refusal('ACCOUNT_NAME_MISSING', 'Name the account to switch to.')
      if (!stateFile) throw refusal('ACCOUNT_STATE_UNAVAILABLE', 'This computer has no place recorded for which account is in use.')

      const record = loadRecord()
      if (record === null) {
        throw refusal(
          registryFileExists() ? 'ACCOUNT_REGISTRY_DAMAGED' : 'ACCOUNT_REGISTRY_ABSENT',
          registryFileExists()
            ? 'The list of accounts on this computer cannot be read, so nothing was changed.'
            : 'There are no accounts on this computer to switch between.',
        )
      }
      const match = findEntry(record, spec, cleanName)
      if (!match) throw refusal('ACCOUNT_UNKNOWN', 'That account is not on this computer’s list.')

      const state = readChoiceState()
      const byProvider = readByProvider(state) || emptyByProvider()
      const chosen = readChosenByProvider(state) || emptyByProvider()
      const previous = byProvider[spec.id]
      const active = { name: match.name, provider: spec.id }

      if (previous === match.name && chosen[spec.id] === match.name && !state?.selectionUnreadableByProvider?.[spec.id]) return { ok: true, switched: false, active }

      const at = new Date().toISOString()
      const history = plainObject(state) && Array.isArray(state.history)
        ? state.history.slice(-(MAX_HISTORY - 1))
        : []
      writeStateRecord({
        ...(plainObject(state) ? state : {}),
        $comment: 'Runtime state for the multi-account switcher. Names and statuses only; no credentials.',
        selectionRevision: randomUUID(),
        selectionUnreadableByProvider: state?.selectionUnreadableByProvider
          ? { ...state.selectionUnreadableByProvider, [spec.id]: false } : null,
        activeAccount: match.name,
        activeByProvider: { ...byProvider, [spec.id]: match.name },

        manualPinByProvider: { ...chosen, [spec.id]: match.name },
        /* `automatic: false` because a person pressed something. The engine's
           own records had 20 selections and every one of them said false while
           nothing in the product could produce a true; the flag only means
           anything if the manual case keeps saying manual. */
        lastSwitch: { at, from: previous, to: match.name, provider: spec.id, automatic: false, reason: 'Chosen on the accounts menu.' },
        history: [...history, {
          at, outcome: 'manual-switch', account: match.name, provider: spec.id, switchedFrom: previous, automatic: false,
        }],
      })
      /* `switched` is about the account in USE, so a press that only records
         the choice -- the computer was already running it, the record named
         someone else -- says false rather than claiming a move nobody saw. */
      return { ok: true, switched: previous !== match.name, active, previous }
    },

    /* THE OFFICIAL COMMAND, AS TEXT, FOR THE PERSON TO RUN THEMSELVES.
     *
     * Nothing here runs it and nothing here reads what it leaves behind. Signing
     * in happens inside the provider's own program, in the person's own browser,
     * which is the one arrangement where this product never touches a
     * credential. */
    signInCommand({ provider, directory, client = null } = {}) {
      const spec = specFor(provider, client)
      if (!spec) {
        throw refusal('ACCOUNT_PROVIDER_UNSUPPORTED', 'There is no sign-in command for that kind of account.')
      }
      return signInCommandFor(spec, directory)
    },
  }
}

/* IS ANY REGISTERED ACCOUNT FOR EACH PROVIDER SIGNED IN: provider -> 'yes',
 * 'no' or 'unknown', for the agent host's start gate (shell/main.cjs
 * providerSignInAnswer). yes beats unknown beats no: one usable sign-in is
 * enough to offer a provider, and one unreadable account must not condemn it.
 *
 * A MISSING CLAUDE SIGN-IN FILE IS NOT A SIGN-OUT (1.0.50 review, accounts C).
 * Claude Code also runs with an API key, a key helper or a cloud provider, and
 * none of those writes .credentials.json. Counting the missing file as "no"
 * refused every Claude start whenever each listed Claude account used one of
 * them -- before the start's own native status check, which accepts all three,
 * ever ran. For Claude an absent (or empty) file therefore answers "unknown"
 * here, as shell/provider-cli-presence.cjs already answers for the default
 * sign-in, and the native check decides. A Codex account still answers "no": a
 * Codex start refuses without its auth.json. */
const SIGN_IN_FILE_ABSENCE_IS_UNKNOWN = Object.freeze(['claude'])
function signInByProvider(accounts) {
  const byProvider = new Map()
  for (const account of Array.isArray(accounts) ? accounts : []) {
    const id = typeof account?.provider === 'string' ? account.provider : null
    if (!id) continue
    const seen = byProvider.get(id)
    const answer = account.signedIn === 'yes' ? 'yes'
      : account.signedIn === 'no' && !SIGN_IN_FILE_ABSENCE_IS_UNKNOWN.includes(id) ? 'no' : 'unknown'
    if (seen === 'yes' || answer === 'yes') byProvider.set(id, 'yes')
    else if (seen === 'unknown' || answer === 'unknown') byProvider.set(id, 'unknown')
    else byProvider.set(id, 'no')
  }
  return byProvider
}

module.exports = {
  PROVIDERS,
  PROVIDER_IDS,
  SIGN_IN_FILE_ABSENCE_IS_UNKNOWN,
  signInByProvider,
  /* Exported so the drift test can hold the composed presence path equal to
     the packed engine's signInFilePath() for every provider. */
  signInFilePath,
  MAX_ACCOUNTS,
  MAX_NAME_LENGTH,
  accountRotationStateFile,
  accountsRegistryFile,
  adoptLegacyAccountRegistry,
  createAccountRegistryStore,
  validateEngineRegistryBytes,
}
