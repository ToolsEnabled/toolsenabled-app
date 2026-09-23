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
 *   priority is a positive whole number, lowest first
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

const DEFAULT_EXHAUSTED_AT_PERCENT = 99
const MAX_ACCOUNTS = 24
const MAX_NAME_LENGTH = 64
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

/* WHICH ACCOUNT GOES FIRST, AS THE SIX ANSWERS THE ENGINE ACTUALLY ACCEPTS.
 *
 * Copied from capability/src/lib/multi-account/selection-modes.js for the same
 * reason the provider table above is copied rather than required: this file is
 * the main process of the shell and must not depend on a payload that a cut
 * build may not carry. The cost of copying is that the two can drift, and the
 * defence against that is the direction of the failure -- the engine
 * normalises anything it does not recognise to `manual`, which never switches
 * accounts on its own. So a mode this table gains and the engine has not is a
 * setting that does nothing; it is never a setting that spends the wrong
 * subscription. tools/test/account-registry.test.mjs deep-compares this list,
 * DEFAULT_SELECTION_MODE and DEFAULT_RESERVE_PERCENT against the packed
 * engine's exports, so drift is a red test rather than a silent setting.
 *
 * The WORDS for these live in the renderer beside the dropdown that shows them
 * (src/account-switcher-state.js). Only the ids are here, because ids are what
 * this process validates and writes. */
const SELECTION_MODE_IDS = Object.freeze([
  'manual', 'priority', 'rotate', 'most-available', 'least-available', 'even', 'dynamic', 'resets-soonest',
])
/* The id the last mode shipped under for a few hours; a record that holds it
   still reads and is written back under the current id. */
const LEGACY_SELECTION_MODES = Object.freeze({ 'expiring-first': 'resets-soonest' })
/* Which window a ranked mode reads: the tighter of the two, the 5-hour one,
   or the weekly one (owner, 2026-09-02). Mirrors the engine's RANK_WINDOW_IDS. */
const RANK_WINDOW_IDS = Object.freeze(['either', 'hourly', 'weekly'])
const DEFAULT_RANK_WINDOW = 'either'
function canonicalMode(value) {
  return Object.hasOwn(LEGACY_SELECTION_MODES, value) ? LEGACY_SELECTION_MODES[value] : value
}

const DEFAULT_SELECTION_MODE = 'priority'
/* A recorded id this build does not know reads as the stop; distinct from the
   default, which is what an ABSENT record means. Mirrors the engine's pair. */
const UNRECOGNISED_SELECTION_MODE = 'manual'
const DEFAULT_RESERVE_PERCENT = 25

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
   ignores them; invalid/defaultable exhaustedAtPercent and priority values are
   also accepted for the same reason. Everything that makes loadRegistry()
   refuse is rejected here, including an empty list. */
function validateEngineRegistryBytes(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    return { ok: false, code: 'ACCOUNT_LEGACY_UNPARSABLE' }
  }
  if (!plainObject(parsed) || !Array.isArray(parsed.accounts) || parsed.accounts.length === 0) {
    return { ok: false, code: 'ACCOUNT_LEGACY_INVALID' }
  }

  const seenNamesAndRoles = new Set()
  const seenDirectories = new Set()
  for (const entry of parsed.accounts) {
    if (!plainObject(entry) || !nonEmptyString(entry.name) || !nonEmptyString(entry.provider)) {
      return { ok: false, code: 'ACCOUNT_LEGACY_ENTRY_INVALID' }
    }
    const spec = Object.hasOwn(PROVIDERS, entry.provider) ? PROVIDERS[entry.provider] : null
    if (!spec) return { ok: false, code: 'ACCOUNT_LEGACY_PROVIDER_UNSUPPORTED' }
    if (!nonEmptyString(entry[spec.dirField])) {
      return { ok: false, code: 'ACCOUNT_LEGACY_ENTRY_INVALID' }
    }

    const nameKey = `${spec.id}:${entry.name.trim().toLowerCase()}`
    if (seenNamesAndRoles.has(nameKey)) return { ok: false, code: 'ACCOUNT_LEGACY_NAME_DUPLICATE' }
    seenNamesAndRoles.add(nameKey)

    if (nonEmptyString(entry.role)) {
      const roleKey = `${spec.id}:role:${entry.role.trim().toLowerCase()}`
      if (seenNamesAndRoles.has(roleKey)) return { ok: false, code: 'ACCOUNT_LEGACY_ROLE_DUPLICATE' }
      seenNamesAndRoles.add(roleKey)
    }

    const directoryKey = `${spec.id}:${entry[spec.dirField].trim().toLowerCase()}`
    if (seenDirectories.has(directoryKey)) return { ok: false, code: 'ACCOUNT_LEGACY_DIRECTORY_SHARED' }
    seenDirectories.add(directoryKey)
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
function createAccountRegistryStore({ file, stateFile = null, servicesRoot = null, fsImpl = fs, fspImpl = fsp, homedir = os.homedir, platform = process.platform, env = process.env, providerIsolation = null } = {}) {
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

  /* A STATE FILE THAT CANNOT BE READ IS MOVED ASIDE, NOT OBEYED AND NOT
     OVERWRITTEN. The 2026-09-02 power loss left it as 9,420 bytes of NUL, and
     a copy seeded into a second instance carried the same bytes; every press
     of "Use this one" then answered "could not be read" until a person renamed
     the file by hand. It is only the memory of the last switch, so the bytes
     are kept under a name that says what they are and the record starts again
     from nothing -- the same rule the engine's own reader applies. Answers the
     quarantine path, or null when there was nothing to move (absent, readable,
     or a rename that failed -- in which case the caller keeps its refusal).
     An exclusive sibling directory owns the destination. Timestamp-only
     rename targets could overwrite an earlier backup within one clock tick.
     Keep one rename rather than copy/link then unlink: a concurrent source
     replacement must be moved intact, never deleted after saving older bytes. */
  function quarantineDamagedState() {
    if (!stateFile || !stateFileExists()) return null
    if (readOwnJson(stateFile) !== null) return null
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
    return aside
  }

  /* The record as it is on disk, with entries left in the provider's own shape
     so that anything this screen does not understand -- a role, an expected
     email address -- survives an add and a remove untouched. */
  function loadRecord() {
    const parsed = readOwnJson(file)
    if (!parsed || !Array.isArray(parsed.accounts)) return null
    return parsed
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

  /* Every entry the file holds that this screen can honestly describe. An entry
     naming an unknown provider, or missing the directory its provider requires,
     is skipped rather than shown wrong -- the engine will refuse the whole file
     for it, and the screen saying so is a separate job from this one. */
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
        priority: Number.isSafeInteger(entry.priority) && entry.priority > 0 ? entry.priority : index + 1,
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
    fsImpl.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`)
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
      if (item.name.toLowerCase() === cleanName.toLowerCase()) {
        return refusal('ACCOUNT_NAME_TAKEN', 'That name is already used for this kind of account.')
      }
      if (sameDirectory(resolveHome(item.directory), resolved)) {
        return refusal('ACCOUNT_FOLDER_SHARED', 'Another account of this kind already uses that folder.')
      }
    }
    return null
  }

  /* THE ONE WRITE BOTH ADDS END IN. The priority is the caller's when it gave
     one and otherwise the next free slot; every key already on the file is
     carried across untouched, and the entry is written in the provider's own
     folder field so the rotation can read it. */
  function appendEntry({ record, existing, spec, name, directory, priority = null, homeCreatedByApp = false }) {
    const nextPriority = priority !== null
      ? priority
      : existing.reduce((highest, item) => Math.max(highest, item.priority), 0) + 1
    const previous = record || {}
    const kept = Array.isArray(previous.accounts) ? previous.accounts : []
    writeRecord({
      ...previous,
      exhaustedAtPercent: Number.isSafeInteger(previous.exhaustedAtPercent)
        && previous.exhaustedAtPercent > 0 && previous.exhaustedAtPercent <= 100
        ? previous.exhaustedAtPercent
        : DEFAULT_EXHAUSTED_AT_PERCENT,
      accounts: [
        ...kept,
        {
          name,
          provider: spec.id,
          ...(spec.client ? { client: spec.client } : {}),
          [spec.dirField]: directory,
          [HOME_CREATED_BY_APP_FIELD]: homeCreatedByApp === true,
          priority: nextPriority,
        },
      ],
    })
    return nextPriority
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

  /* WHICH ACCOUNT EACH PROGRAM WAS TOLD TO USE, WHICH IS A DIFFERENT QUESTION.
     `activeByProvider` above is overwritten by every start, including a
     failover, so it cannot preserve the person's explicit menu choice.
     The engine records that choice separately in `manualPinByProvider`,
     where no start writes it.

     A RECORD WRITTEN BEFORE THAT FIELD EXISTED STILL ANSWERS, from the last
     `manual-switch` entry about each program -- the same walk the engine's own
     manualPin() does. An entry naming no program is what a record written
     before THAT field existed looks like, and it answers for whichever program
     has not been answered yet. */
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

  /* WHEN THE COMPUTER MOVED OFF THE ACCOUNT THE PERSON CHOSE, AND WHY.
     Without this the menu showed the failover's account as the one in use and
     said nothing at all, which from the outside is a choice that reverted
     itself. The reason is the CHOSEN account's own line from that start's
     attempt trail, because the figure and the reset that made the walk move on
     are what turn "could not serve" into something a person can act on.
     "Could not look" and "not there" are different answers: a start that never
     tried the chosen account carries no line for it, and a null reason says so
     rather than inventing one. */
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

  function readMode(value) {
    const mode = canonicalMode(value)
    return SELECTION_MODE_IDS.includes(mode) ? mode : (value == null ? null : UNRECOGNISED_SELECTION_MODE)
  }
  function readReserve(value) {
    return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null
  }
  function readRankWindow(value) {
    return RANK_WINDOW_IDS.includes(value) ? value : null
  }

  function readPolicy(record) {
    const source = plainObject(record) ? record : {}
    const mode = readMode(source.selectionMode)
    const reserve = readReserve(source.reservePercent)
    const rankWindow = readRankWindow(source.rankWindow)
    /* ONE RULE PER PROGRAM where the person set one (owner, 2026-09-02: "by
       provider"): each program's answer is its own entry where that has a
       field, the global rule otherwise, and `own` says per field which it was
       so the menu can draw "same as above" honestly for each. */
    const overrides = plainObject(source.selectionByProvider) ? source.selectionByProvider : {}
    const byProvider = {}
    for (const id of PROVIDER_IDS) {
      const entry = plainObject(overrides[id]) ? overrides[id] : {}
      const ownMode = readMode(entry.selectionMode)
      const ownReserve = readReserve(entry.reservePercent)
      const ownWindow = readRankWindow(entry.rankWindow)
      byProvider[id] = {
        selectionMode: ownMode !== null ? ownMode : (mode !== null ? mode : DEFAULT_SELECTION_MODE),
        reservePercent: ownReserve !== null ? ownReserve : (reserve !== null ? reserve : DEFAULT_RESERVE_PERCENT),
        rankWindow: ownWindow !== null ? ownWindow : (rankWindow !== null ? rankWindow : DEFAULT_RANK_WINDOW),
        own: { selectionMode: ownMode !== null, reservePercent: ownReserve !== null, rankWindow: ownWindow !== null },
      }
    }
    return {
      /* `recorded` is what tells "nobody has chosen" from "somebody chose the
         cautious one", and the engine layers those two differently over the
         older walkthrough answer. Collapsing them here would make the dropdown
         unable to show a person that their choice took effect. */
      recorded: SELECTION_MODE_IDS.includes(canonicalMode(source.selectionMode)),
      selectionMode: mode !== null ? mode : DEFAULT_SELECTION_MODE,
      /* KEEPING TRYING IS ON UNLESS SOMEBODY TURNED IT OFF, and this is the one
         place that decides it.

         It read `=== true`, so an absent key answered false and the recovery
         machinery -- account-recovery-coordinator, rotation, handover -- was
         built, shipped and never enabled. What the owner saw was every turn
         failing on a spent account until they switched by hand, which is the
         complaint this change exists to answer.

         `!== false` rather than `=== true` is the whole change, and it is
         deliberately asymmetric: ABSENT means nobody has decided, and the
         product should do the useful thing; literal `false` means somebody went
         and turned it off, and that must survive every read and every write.
         setPolicy already refuses a non-boolean, so `false` here can only have
         been chosen on purpose.

         This is also why the reported "the setting reverts" needs no separate
         fix: setPolicy spreads the record it read, so a partial save keeps the
         key, and JSON round-trips a boolean exactly. It was never reverting --
         it was defaulting off and only ever reading true when written. */
      autoRecoverOnLimit: source.autoRecoverOnLimit !== false,
      reservePercent: reserve !== null ? reserve : DEFAULT_RESERVE_PERCENT,
      rankWindow: rankWindow !== null ? rankWindow : DEFAULT_RANK_WINDOW,
      byProvider,
      exhaustedAtPercent: Number.isSafeInteger(source.exhaustedAtPercent)
        && source.exhaustedAtPercent > 0 && source.exhaustedAtPercent <= 100
        ? source.exhaustedAtPercent
        : DEFAULT_EXHAUSTED_AT_PERCENT,
      /* ONE LIMIT PER WINDOW, and null means "this window has no limit of
         its own, so it uses the single number above". Null rather than a
         copy of that number, because the menu has to be able to draw the
         difference between a limit somebody chose and one they inherited --
         the same distinction `recorded` exists for on the mode. */
      exhaustedAtPercentHourly: windowLimitOf(source.exhaustedAtPercentHourly),
      exhaustedAtPercentWeekly: windowLimitOf(source.exhaustedAtPercentWeekly),
    }
  }

  /* A per-window limit as recorded, or null when the file names none. The
     same bounds the engine's registry.js applies, so a number this store
     accepts is a number that side reads back. */
  function windowLimitOf(value) {
    return Number.isSafeInteger(value) && value > 0 && value <= 100 ? value : null
  }

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
    fsImpl.rmSync(privatePath(signInFilePath(resolved, spec)), { force: true })
    return { credentialDestroyed: true }
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
  function resolvedHomeOf({ name, provider } = {}) {
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
    const match = record === null ? null : findEntry(record, spec, cleanName)
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
      const record = loadRecord()
      const damaged = record === null && registryFileExists()
      const accounts = usableEntries(record)
        .map(item => {
          const resolved = resolveHome(item.directory)
          return {
            name: item.name,
            provider: item.spec.id,
            ...(item.spec.client ? { client: item.spec.client } : {}),
            directory: resolved || item.directory,
            priority: item.priority,
            signedIn: signedInAt(item.spec, resolved),
          }
        })
        .sort((a, b) => (a.priority - b.priority)
          || a.provider.localeCompare(b.provider)
          || a.name.localeCompare(b.name))
      return {
        ok: true,
        accounts,
        damaged,
        /* THE SWITCHING RULE FROM THE SAME READ. One file, read once, so the
           accounts and the rule that orders them are one answer rather than
           two reads that a write landing between them could split. Same shape
           as policy(), so a reader of either sees the same thing. */
        policy: damaged
          ? { ok: false, code: 'ACCOUNT_REGISTRY_DAMAGED', policy: null }
          : { ok: true, code: null, policy: readPolicy(record) },
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
      const record = loadRecord()
      const damaged = record === null && registryFileExists()
      const accounts = await Promise.all(usableEntries(record).map(async item => {
        const resolved = resolveHome(item.directory)
        const generation = includeAuthGeneration ? await signInGenerationAtAsync(item.spec, resolved) : null
        return {
          name: item.name,
          provider: item.spec.id,
          ...(item.spec.client ? { client: item.spec.client } : {}),
          directory: resolved || item.directory,
          priority: item.priority,
          signedIn: generation ? generation.signedIn : await signedInAtAsync(item.spec, resolved),
          ...(generation ? { authGeneration: generation.authGeneration } : {}),
        }
      }))
      accounts.sort((a, b) => (a.priority - b.priority)
        || a.provider.localeCompare(b.provider)
        || a.name.localeCompare(b.name))
      return {
        ok: true,
        accounts,
        damaged,
        policy: damaged
          ? { ok: false, code: 'ACCOUNT_REGISTRY_DAMAGED', policy: null }
          : { ok: true, code: null, policy: readPolicy(record) },
      }
    },

    add({ name, provider, client = null, directory, priority } = {}) {
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
      let cleanPriority = null
      if (priority !== undefined && priority !== null && priority !== '') {
        const asNumber = typeof priority === 'number' ? priority : Number(priority)
        if (!Number.isSafeInteger(asNumber) || asNumber <= 0) {
          throw refusal('ACCOUNT_PRIORITY_INVALID', 'The order must be a whole number above zero.')
        }
        cleanPriority = asNumber
      }

      const { record, existing } = loadForAppend()
      const collision = collisionOf(existing, spec, cleanName, resolved)
      if (collision) throw collision
      appendEntry({ record, existing, spec, name: cleanName, directory: cleanDirectory,
        priority: cleanPriority, homeCreatedByApp: false })
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
    homeOf({ name, provider } = {}) {
      const account = resolvedHomeOf({ name, provider })
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
      if (cleanNew.toLowerCase() !== match.name.toLowerCase() && findEntry(record, spec, cleanNew)) {
        throw refusal('ACCOUNT_NAME_TAKEN', 'That name is already used for this kind of account.')
      }
      writeRecord({ ...record, accounts: record.accounts.map(entry => (entry === match.entry ? { ...entry, name: cleanNew } : entry)) })

      /* The account in use keeps its place under its new name. A record that
         cannot be read is left alone here: renaming the list is the press,
         and the quarantine belongs to the reads that need the record. */
      if (stateFile) {
        const state = readOwnJson(stateFile)
        if (plainObject(state)) {
          const byProvider = readByProvider(state)
          const wasActive = Boolean(byProvider && byProvider[spec.id] === match.name)
          const legacyActive = nonEmptyString(state.activeAccount) && state.activeAccount.trim() === match.name
          if (wasActive || legacyActive) {
            writeStateRecord({
              ...state,
              ...(legacyActive ? { activeAccount: cleanNew } : {}),
              ...(wasActive ? { activeByProvider: { ...(plainObject(state.activeByProvider) ? state.activeByProvider : {}), [spec.id]: cleanNew } } : {}),
            })
          }
        }
      }
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
      const state = readOwnJson(stateFile)
      if (!state) {
        quarantineDamagedState()
        return empty
      }
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
      /* THE SWITCH ITSELF, NOT JUST ITS CLOCK TIME.
       *
       * `at` above has always been read off this same record and the rest of it
       * thrown away, so the menu could say WHEN this computer last changed
       * account and never what the change WAS. The one sentence a person needs
       * after an automatic failover -- "your work moved from work to spare
       * because work ran out" -- was unwritable from the answer, and the
       * failover is exactly the change nobody was present for.
       *
       * BOUNDED AND WORD-BY-WORD, never the record whole. This file is written
       * by the engine's switcher and carries whatever fields it grows; copying
       * the object across would hand a screen values nothing here has read.
       * `automatic` is three-valued on purpose: a record written before the
       * field existed did not say, and "not stated" must not draw as "you did
       * this yourself". */
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
        lastSwitch: lastSwitchOut,
        /* The choice and its consequence travel together: "which account did I
           pick" is only half an answer while the computer is running another
           one and nothing says so. Both are null when the record has nothing
           to say, which is different from a table saying nobody chose. */
        chosenByProvider,
        movedOffByProvider: movedOffByProvider(state, chosenByProvider),
      }
    },

    /* HOW THIS COMPUTER PICKS BETWEEN THE ACCOUNTS ABOVE.
     *
     * It lives in the SAME file as the accounts, and that is the whole design
     * rather than a convenience: a rule kept somewhere else is a second answer
     * to one question, and the day the two disagree nothing says which is in
     * force. The engine reads these two fields straight off the registry it
     * already loads (capability/src/lib/multi-account/registry.js), so what
     * this screen writes is what the next start obeys -- with no third party
     * carrying the value between them.
     *
     * A DAMAGED FILE IS UNREADABLE, NOT DEFAULT. Every other read here says so;
     * this one has to as well, or a person whose list cannot be parsed is shown
     * "Stop and let me switch" as though they had chosen it. */
    policy() {
      const record = loadRecord()
      if (record === null && registryFileExists()) {
        return { ok: false, code: 'ACCOUNT_REGISTRY_DAMAGED', policy: null }
      }
      return { ok: true, code: null, policy: readPolicy(record) }
    },

    /* CHANGING IT REWRITES THOSE TWO FIELDS AND NOTHING ELSE.
     *
     * The accounts array is carried across by reference from what was read, so
     * choosing a mode can never reorder, drop or rewrite an account. An absent
     * registry is REFUSED rather than created: a switching rule for a list that
     * does not exist is a file with no accounts in it, which the engine treats
     * as a loud refusal (ACCOUNTS_REGISTRY_EMPTY) rather than as the quiet
     * normal absence. */
    /* `provider` names ONE program's rule instead of the global one; there a
       field sent as null takes that program back to "same as above". The
       rank window (which window the ranking reads) travels the same way. */
    setPolicy({
      autoRecoverOnLimit,
      selectionMode, reservePercent, rankWindow,
      exhaustedAtPercentHourly, exhaustedAtPercentWeekly,
      provider
    } = {}) {
      const scoped = provider !== undefined && provider !== null
      if (autoRecoverOnLimit !== undefined && (typeof autoRecoverOnLimit !== 'boolean' || scoped)) {
        throw refusal('ACCOUNT_RECOVERY_INVALID', 'Automatic recovery must be on or off for this computer.')
      }
      if (scoped && !specFor(provider)) {
        throw refusal('ACCOUNT_PROVIDER_UNSUPPORTED', 'That kind of account has no rule of its own here.')
      }
      const cleanMode = selectionMode === undefined ? undefined
        : (selectionMode === null ? null : canonicalMode(selectionMode))
      if (cleanMode !== undefined && cleanMode !== null && !SELECTION_MODE_IDS.includes(cleanMode)) {
        throw refusal('ACCOUNT_MODE_UNSUPPORTED', 'That way of choosing an account is not one this copy offers.')
      }
      if (cleanMode === null && !scoped) {
        throw refusal('ACCOUNT_MODE_UNSUPPORTED', 'That way of choosing an account is not one this copy offers.')
      }
      const cleanWindow = rankWindow === undefined ? undefined : (rankWindow === null ? null : rankWindow)
      if (cleanWindow !== undefined && cleanWindow !== null && !RANK_WINDOW_IDS.includes(cleanWindow)) {
        throw refusal('ACCOUNT_RANK_WINDOW_UNSUPPORTED', 'That window is not one the ranking can read.')
      }
      if (cleanWindow === null && !scoped) {
        throw refusal('ACCOUNT_RANK_WINDOW_UNSUPPORTED', 'That window is not one the ranking can read.')
      }
      /* A NUMBER, OR NOTHING. An absent key leaves the recorded value alone;
         anything present must already be a finite number from 0 to 100. There
         is deliberately no Number() coercion here: it turned a cleared box
         into 0, `true` into 1 and `[]` into 0, each of them a reserve nobody
         chose, saved with a "Saved" confirmation. */
      let cleanReserve
      if (reservePercent !== undefined && reservePercent !== null) {
        if (typeof reservePercent !== 'number' || !Number.isFinite(reservePercent)
          || reservePercent < 0 || reservePercent > 100) {
          throw refusal('ACCOUNT_RESERVE_INVALID', 'The reserve must be a number between 0 and 100.')
        }
        cleanReserve = Math.round(reservePercent)
      }

      /* THE TWO PER-WINDOW LIMITS, HELD TO THE SAME RULE AS THE RESERVE: a
         number or nothing, never a coercion. `null` is meaningful and
         different from absent -- it CLEARS this window's own limit and hands
         it back to the single number -- so it is carried through rather than
         treated as "leave alone".

         1 is the floor rather than 0, because a limit of 0 means every
         account is spent before it has done anything, which is a fleet that
         cannot start and a number nobody would choose on purpose. The engine
         reads the same field with the same bound. */
      const cleanWindowLimit = (value, field) => {
        if (value === undefined) return undefined
        if (value === null) return null
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 100) {
          throw refusal('ACCOUNT_WINDOW_LIMIT_INVALID',
            'A window limit must be a number between 1 and 100, or cleared.')
        }
        return Math.round(value)
      }
      const cleanHourly = cleanWindowLimit(exhaustedAtPercentHourly, 'hourly')
      const cleanWeekly = cleanWindowLimit(exhaustedAtPercentWeekly, 'weekly')

      /* THEY ARE THIS COMPUTER'S, NOT ONE PROGRAM'S. The engine reads them off
         the top of the registry for every provider, so accepting them under a
         provider scope would record a number that nothing ever reads -- a
         control that says Saved and does nothing. */
      if (scoped && (cleanHourly !== undefined || cleanWeekly !== undefined)) {
        throw refusal('ACCOUNT_WINDOW_LIMIT_NOT_SCOPED',
          'The allowance limits are set once for this computer, not per program.')
      }

      const record = loadRecord()
      if (record === null) {
        throw refusal(
          registryFileExists() ? 'ACCOUNT_REGISTRY_DAMAGED' : 'ACCOUNT_REGISTRY_ABSENT',
          registryFileExists()
            ? 'The list of accounts on this computer cannot be read, so nothing was changed.'
            : 'There are no accounts on this computer yet, so there is nothing to choose between. Add one first.',
        )
      }
      let next
      if (scoped) {
        const table = plainObject(record.selectionByProvider) ? { ...record.selectionByProvider } : {}
        const entry = plainObject(table[provider]) ? { ...table[provider] } : {}
        if (cleanMode !== undefined) { if (cleanMode === null) delete entry.selectionMode; else entry.selectionMode = cleanMode }
        if (cleanReserve !== undefined) entry.reservePercent = cleanReserve
        if (cleanWindow !== undefined) { if (cleanWindow === null) delete entry.rankWindow; else entry.rankWindow = cleanWindow }
        if (Object.keys(entry).length === 0) delete table[provider]
        else table[provider] = entry
        next = { ...record }
        if (Object.keys(table).length === 0) delete next.selectionByProvider
        else next.selectionByProvider = table
      } else {
        next = {
          ...record,
          ...(autoRecoverOnLimit === undefined ? {} : { autoRecoverOnLimit }),
          ...(cleanMode === undefined ? {} : { selectionMode: cleanMode }),
          ...(cleanReserve === undefined ? {} : { reservePercent: cleanReserve }),
          ...(cleanWindow === undefined ? {} : { rankWindow: cleanWindow }),
          ...(cleanHourly === undefined || cleanHourly === null ? {} : { exhaustedAtPercentHourly: cleanHourly }),
          ...(cleanWeekly === undefined || cleanWeekly === null ? {} : { exhaustedAtPercentWeekly: cleanWeekly }),
        }
        /* Cleared means the key LEAVES the file, so the engine falls back to
           the single number rather than reading a limit of null. */
        if (cleanHourly === null) delete next.exhaustedAtPercentHourly
        if (cleanWeekly === null) delete next.exhaustedAtPercentWeekly
      }
      writeRecord(next)
      return { ok: true, policy: readPolicy(next) }
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
     * re-checks the account it lands on and fails over or stops exactly as it
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

      const state = readOwnJson(stateFile)
      if (state === null && stateFileExists() && quarantineDamagedState() === null) {
        throw refusal('ACCOUNT_STATE_DAMAGED', 'The record of which account is in use could not be read, so the switch was not made.')
      }
      const byProvider = readByProvider(state) || emptyByProvider()
      const chosen = readChosenByProvider(state) || emptyByProvider()
      const previous = byProvider[spec.id]
      const active = { name: match.name, provider: spec.id }
      /* NOTHING TO DO ONLY WHEN THE CHOICE ALREADY SAYS SO TOO. The account in
         use matching is not enough: after a failover back onto the chosen
         account the two agree while the record still names someone else, and
         after this press the person's answer to "which one" has changed even
         though nothing moved. Pressing it again, on a record that already
         says it, writes nothing. */
      if (previous === match.name && chosen[spec.id] === match.name) return { ok: true, switched: false, active }

      const at = new Date().toISOString()
      const history = plainObject(state) && Array.isArray(state.history)
        ? state.history.slice(-(MAX_HISTORY - 1))
        : []
      writeStateRecord({
        ...(plainObject(state) ? state : {}),
        $comment: 'Runtime state for the multi-account switcher. Names and statuses only; no credentials.',
        activeAccount: match.name,
        activeByProvider: { ...byProvider, [spec.id]: match.name },
        /* THE CHOICE, WHERE NO START WILL OVERWRITE IT. `activeByProvider` above
           is rewritten by every start including a failover, so it recorded the
           press for as long as it took the next agent to begin -- MEASURED
           2026-09-03 on the owner's machine: 87 seconds. The engine reads this
           field on every start and puts the named account first. */
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

module.exports = {
  PROVIDERS,
  PROVIDER_IDS,
  /* Exported so the drift test can hold the composed presence path equal to
     the packed engine's signInFilePath() for every provider. */
  signInFilePath,
  SELECTION_MODE_IDS,
  LEGACY_SELECTION_MODES,
  RANK_WINDOW_IDS,
  DEFAULT_RANK_WINDOW,
  DEFAULT_SELECTION_MODE,
  DEFAULT_RESERVE_PERCENT,
  MAX_ACCOUNTS,
  MAX_NAME_LENGTH,
  accountRotationStateFile,
  accountsRegistryFile,
  adoptLegacyAccountRegistry,
  createAccountRegistryStore,
  validateEngineRegistryBytes,
}
