'use strict'

/* IS THE OWNER'S CARD ON FILE -- asked by the installed product, of its own vault.
 *
 * WHY THE PRODUCT COULD NOT ANSWER THIS. Two separate faults, and only one of
 * them was in the engine:
 *
 *   1. `payment_method.card_status` asked `secretExists()`, which answers by
 *      FETCHING the record -- and `payment_card_default` is on
 *      tools/secrets.ps1's $VaultOracleDenylist precisely so that fetch is
 *      refused. The refusal was caught and returned as `false`. Fixed in the
 *      engine tree by a presence-only verb; this file is its shell-side caller.
 *
 *   2. The installed product's vault is NOT the vault the owner entered his
 *      card into. `shell/main.cjs` points the capability layer at
 *      `<userData>/capability`, so the product resolves
 *      `<userData>/capability/vault/secrets.json`, while the record lives in
 *      the engine checkout's `vault/secrets.json`. Measured on this machine:
 *      the installation's own vault holds two audit keys and no card.
 *
 * The second one is why this module reports WHICH STORE it asked. A screen that
 * only has a boolean can say "no card on file" when the truth is "this
 * installation has never been shown your card", and those are different
 * sentences with different next steps for the person reading them.
 *
 * NOTHING ABOUT THE RECORD CROSSES THIS BOUNDARY. The verb it runs prints
 * nothing, decrypts nothing, and answers through an exit code. There is no
 * branch here that can return a card number, an expiry, a token or a length,
 * because no such value is ever produced on the other side of the spawn.
 *
 * FAIL CLOSED MEANS FAIL UNKNOWN. A vault that cannot be read answers
 * `present: null`, never `false`. "I could not check" rendered as "you have no
 * card" is a false statement about the owner's money made out of a file error.
 *
 * ------------------------------------------------------------------------
 * THIS FILE ALSO HOLDS THE SHELL'S ONE VALUE READER, AND THE PARAGRAPH ABOVE
 * IS NOT WEAKENED BY IT.
 *
 * "Nothing about the record crosses this boundary" is a promise made by
 * `vaultRecordPresence`, about the card, and it still holds: that function runs
 * a verb that decrypts nothing and answers through an exit code.
 *
 * `vaultRecordValues` below is a different question -- "what are these records"
 * -- and it exists because the main process had NO way to ask it. Google
 * sign-in needs two strings, the product's own credential catalogue says
 * credentials live in the vault, and the resolver could only read files, so an
 * owner who put them where the product says they go was told the feature was
 * unavailable. Nine attempts of that were blamed on the person.
 *
 * IT IS HERE RATHER THAN IN A NEW MODULE ON PURPOSE. Four things have to be
 * right to talk to the vault from Electron's main process: where
 * `tools/secrets.ps1` is, that TOOLSENABLED_VAULT_PATH must be CLEARED and
 * TOOLSENABLED_STATE_ROOT SET so the question lands on the installation's own
 * store, that the spawn is bounded, and that a failure is UNKNOWN rather than
 * "no". A second module would be a second copy of all four, and two ways to do
 * one thing is the defect this project has ruled against twice. So both
 * questions are asked through the same resolution, in one file, and the file's
 * name understates what it holds.
 *
 * WHAT IS STILL FORBIDDEN HERE. No value is logged, printed, put in a `detail`
 * sentence, or returned on any refusal path -- every failure answers with a
 * code and a fixed sentence that names nothing but the key. There is no
 * `console` call anywhere in this file, and tools/test/google-signin.test.mjs
 * asserts that there is not.
 */

const { execFile, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { readPolicy, mayRead } = require('./vault-access-policy.cjs')

/* Exit codes of the `present` action in tools/secrets.ps1. Named on both sides
   so a change to either is a visible edit to both. */
const PRESENT = 0
const ABSENT = 3
const UNREADABLE = 4
const NO_STORE = 5

const VAULT_KEY_RE = /^[A-Za-z0-9_.-]{1,120}$/
/* Bounded because this spawns a program -- but the old bound was measured on an
   IDLE machine and was wrong on a busy one.
 *
 * MEASURED on this machine while ~100 agents were running: six consecutive
 * reads of one record took 15031ms (timeout), 13099ms, 15035ms, 15034ms,
 * 15028ms and 5372ms. Every failure was the old 15-second ceiling hit exactly,
 * and it failed more often than it succeeded -- for a read the comment below
 * used to describe as "well under a second". A customer running a virus scan
 * meets the same thing on day one, and the failure renders as "your credentials
 * could not be read".
 *
 * The ceiling can afford to be generous now only because these reads no longer
 * block the window (see execFileAsync). Waiting costs latency; it used to cost
 * a frozen application. A hung shell still becomes "unknown" rather than a
 * spinner without end -- just not one that fires on an ordinary busy laptop. */
const TIMEOUT_MS = 45_000

/* Linux uses the installed engine's asynchronous reader, not a PowerShell
   compatibility shim. Only that reader knows the encrypted helper protocol.
   Its child owns a copied, scrubbed environment and an explicit state root;
   Electron's process.env and event loop are never borrowed for a sync read.
   Presence verifies store metadata and backend readiness; neither platform's
   presence path decrypts or returns a record value. */
function linuxVaultReader({ capabilityRoot, stateRoot, loadLinuxVault = require }) {
  if (typeof capabilityRoot !== 'string' || !path.isAbsolute(capabilityRoot)) {
    throw Object.assign(new Error('Unavailable vault reader.'), { code: 'VAULT_TOOLING_ABSENT' })
  }
  if (typeof stateRoot !== 'string' || stateRoot !== stateRoot.trim() || !path.isAbsolute(stateRoot)) {
    throw Object.assign(new Error('Invalid vault state root.'), { code: 'SECRET_VAULT_PATH_UNSAFE' })
  }
  const file = path.join(capabilityRoot, 'src', 'lib', 'vault-linux.js')
  try {
    if (!fs.statSync(file).isFile()) throw Object.assign(new Error('Missing reader.'), { code: 'ENOENT' })
  } catch (error) {
    throw Object.assign(new Error('Unavailable vault reader.'), {
      code: error?.code === 'ENOENT' ? 'VAULT_TOOLING_ABSENT' : 'VAULT_TOOLING_CHECK_FAILED',
    })
  }
  const adapter = loadLinuxVault(file)
  if (typeof adapter?.createReader !== 'function') {
    throw Object.assign(new Error('Incompatible vault reader.'), { code: 'SECRET_HELPER_PROTOCOL_INVALID' })
  }
  return adapter.createReader({ stateRoot, environment: vaultEnvironment(stateRoot) })
}

function linuxVaultFailure(error) {
  const explanations = {
    VAULT_TOOLING_ABSENT: 'This installation cannot find its Linux vault reader. What the vault holds is unknown.',
    VAULT_TOOLING_CHECK_FAILED: 'This installation could not check its Linux vault reader just now. What the vault holds is unknown.',
    SECRET_BACKEND_LOCKED: 'The local login keyring is locked. Unlock it locally before using this installation’s vault.',
    SECRET_BACKEND_UNAVAILABLE: 'The supported Linux secret service is unavailable. What the vault holds is unknown.',
    SECRET_BACKEND_UNSAFE: 'The available Linux keyring is not a supported encrypted persistent backend. What the vault holds is unknown.',
    SECRET_BACKEND_KEY_MISSING: 'The encrypted vault’s key is unavailable. What the vault holds is unknown.',
    SECRET_ACCESS_DENIED: 'This record cannot be read through the generic vault interface.',
    SECRET_VAULT_PATH_UNSAFE: 'The vault requires an explicit owned private state directory. What the vault holds is unknown.',
    SECRET_HELPER_UNAVAILABLE: 'The installed Linux vault helper’s native dependencies are unavailable. What the vault holds is unknown.',
    SECRET_HELPER_PROTOCOL_INVALID: 'The Linux vault reader did not return a valid answer. What the vault holds is unknown.',
  }
  const code = typeof error?.code === 'string' && Object.hasOwn(explanations, error.code)
    ? error.code : 'VAULT_READ_FAILED'
  return {
    code,
    detail: explanations[code] || 'The Linux vault could not be read or authenticated. What it holds is unknown.',
  }
}

async function linuxRecordPresence(key, options) {
  const store = vaultStorePath(options.stateRoot)
  try {
    const result = await linuxVaultReader(options).presence(key)
    if (result === 'present') {
      return answer(true, true, 'VAULT_RECORD_PRESENT', 'A record is on file under this key in this installation’s vault. No record value was returned.', { store })
    }
    if (result === 'absent') {
      return answer(false, true, 'VAULT_RECORD_ABSENT', 'This installation’s vault was read and holds no record under this key.', { store })
    }
    if (result === 'no-store') {
      return answer(false, true, 'VAULT_STORE_ABSENT', 'This installation has no vault store yet, so nothing is on file in it.', { store })
    }
    throw Object.assign(new Error('Invalid presence response.'), { code: 'SECRET_HELPER_PROTOCOL_INVALID' })
  } catch (error) {
    const { code, detail } = linuxVaultFailure(error)
    return answer(null, false, code, detail, { store })
  }
}

/* THE NAMES, ON LINUX -- AND WHY THIS IS A REFUSAL RATHER THAN A READ.
 *
 * MEASURED against the engine candidate's src/lib/vault-linux.js:
 * `createReader()` returns exactly `{ presence, getMany }`. Neither answers
 * "what is in there" -- `getMany` needs the keys, which is the question being
 * asked. The module DOES export a top-level `list()`, and it is deliberately
 * not borrowed here for two reasons the same file states: it is `run(...)`,
 * SYNCHRONOUS, and this seam's whole rebuild was to stop a vault read blocking
 * the thread that paints; and it resolves the vault from the ambient
 * environment, which is precisely what `createReader` exists to prevent --
 * "Neither a stale ambient vault override nor concurrent readers may redirect
 * it by mutating process.env." Borrowing it would ask a different store from
 * the one the owner's records are in, on the main thread.
 *
 * So the honest answer on Linux today is a NAMED refusal with its own code, and
 * the control says the limitation in words rather than drawing an empty list or
 * a bare "unknown". The fix belongs in the engine: `createReader` needs an
 * asynchronous, state-root-bound name verb. Until it has one this reports the
 * gap instead of hiding it. An empty list is never the answer -- that would be
 * a claim about the vault's contents this seam has no grounds to make. */
async function linuxRecordNames(options) {
  const store = vaultStorePath(options.stateRoot)
  try {
    const reader = linuxVaultReader(options)
    if (typeof reader?.names !== 'function') {
      return unreadableNames(
        'VAULT_NAMES_UNSUPPORTED',
        'On Linux this installation can check whether a named record is on file, but it cannot yet list what its vault holds, '
        + 'so this list is empty because the question cannot be asked here — not because your vault is. '
        + 'Adding and removing a credential by name still work.',
        store,
      )
    }
    const listed = await reader.names()
    const names = keyNamesFrom(listed)
    if (!names) return invalidVaultNames(store)
    return readNames(names, store)
  } catch (error) {
    const { code, detail } = linuxVaultFailure(error)
    return unreadableNames(code, detail, store)
  }
}

async function linuxRecordValues(keys, options) {
  const store = vaultStorePath(options.stateRoot)
  try {
    const selected = await linuxVaultReader(options).getMany(keys)
    if (!(selected instanceof Map) || [...selected.keys()].some(key => !keys.includes(key))) {
      return invalidVaultResponse(store)
    }
    const values = new Map()
    const absent = []
    for (const key of keys) {
      if (!selected.has(key)) { absent.push(key); continue }
      const value = selected.get(key)
      if (typeof value !== 'string') return invalidVaultResponse(store)
      if (value.trim()) values.set(key, value.trim())
      else absent.push(key)
    }
    return Object.freeze({
      readable: true, code: 'VAULT_RECORDS_READ', detail: 'This installation’s vault was read.',
      store, values, absent: Object.freeze(absent),
    })
  } catch (error) {
    const { code, detail } = linuxVaultFailure(error)
    return unreadableRecords(code, detail, store)
  }
}

function answer(present, readable, code, detail, extra = {}) {
  return Object.freeze({ present, readable, code, detail, ...extra })
}

/* WHERE THE VAULT IS, ASKED ONCE, ANSWERED FOR BOTH QUESTIONS. These three
   helpers were inline in vaultRecordPresence and are now shared, so the value
   reader below cannot drift into resolving a different script, a different
   store, or a different environment from the presence question. */

function vaultScriptPath(capabilityRoot) {
  if (typeof capabilityRoot !== 'string' || !capabilityRoot) return { script: null, error: null }
  const script = path.join(capabilityRoot, 'tools', 'secrets.ps1')
  try {
    fs.statSync(script)
    return { script, error: null }
  } catch (error) {
    /* ENOENT IS THE ONE DEFINITE ANSWER. existsSync used to turn every reason
       it could not inspect the helper (including EMFILE/EAGAIN/EIO/EBUSY) into
       `false`, which made a busy machine look like an installation with no
       tooling. Do not retain either result: a transient failure must be tried
       again on the next request, while a newly installed helper must become
       visible without restarting the shell. */
    const code = error && typeof error.code === 'string' ? error.code.toUpperCase() : ''
    return { script: null, error: code === 'ENOENT' ? null : code || 'UNKNOWN' }
  }
}

function toolingLookupFailed(subject, store) {
  const detail = `This installation could not check for the program that reads its vault just now, so ${subject} is unknown. This is not claiming that the program or any vault record is absent.`
  return store === undefined
    ? answer(null, false, 'VAULT_TOOLING_CHECK_FAILED', detail)
    : unreadableRecords('VAULT_TOOLING_CHECK_FAILED', detail, store)
}

function vaultStorePath(stateRoot) {
  return typeof stateRoot === 'string' && stateRoot
    ? path.join(stateRoot, 'vault', 'secrets.json')
    : null
}

/* The script resolves TOOLSENABLED_VAULT_PATH first and TOOLSENABLED_STATE_ROOT
   second. An ambient VAULT_PATH inherited from whatever shell launched the app
   would silently point these questions at a different file from the one the
   product actually uses, so it is cleared rather than trusted. */
function vaultEnvironment(stateRoot, base = process.env) {
  const environment = { ...base }
  if (typeof stateRoot === 'string' && stateRoot) environment.TOOLSENABLED_STATE_ROOT = stateRoot
  delete environment.TOOLSENABLED_VAULT_PATH
  return environment
}

/**
 * Ask the installation's own vault whether a record is on file.
 *
 * @param {string} vaultKey the vault record's key NAME. Never a value.
 * @param {object} options
 * @param {string} options.capabilityRoot directory holding `tools/secrets.ps1`
 * @param {string} options.stateRoot the state root whose `vault/` is the store
 */
/* THIS USED TO RUN ON ELECTRON'S MAIN THREAD, SYNCHRONOUSLY, AND FREEZE THE
 * WINDOW. execFileSync spawns powershell.exe and waits; the main thread is the
 * one that paints. On a loaded machine that measured 5 to 15 seconds, so
 * opening the sign-in screen could stop the whole application dead and then
 * report that the vault was unreadable.
 *
 * THE ERROR SHAPE IS DELIBERATELY THE SYNC ONE. execFileSync rejects with
 * `status`; callback execFile reports the exit code as `code`. The readers
 * below decide PRESENT / ABSENT / UNREADABLE by reading `status`, and teaching
 * them a second vocabulary would mean two ways to ask one question. So the exit
 * code is copied onto `status` here and every caller stays as it was.
 *
 * `run` remains injectable and callers `await` it, which is why a test that
 * injects a SYNCHRONOUS stub keeps working unchanged: awaiting a plain value is
 * the value. */
function execFileAsync(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout) => {
      if (error) {
        if (!Number.isInteger(error.status) && Number.isInteger(error.code)) error.status = error.code
        reject(error)
        return
      }
      resolve(stdout)
    })
  })
}

async function vaultRecordPresence(vaultKey, options = {}) {
  const { capabilityRoot, stateRoot, run = execFileAsync, platform = process.platform } = options || {}
  if (typeof vaultKey !== 'string' || !VAULT_KEY_RE.test(vaultKey)) {
    return answer(null, false, 'VAULT_KEY_INVALID', 'That is not a vault record this product will ask about.')
  }
  if (typeof capabilityRoot !== 'string' || !capabilityRoot) {
    return answer(null, false, 'VAULT_TOOLING_ABSENT', 'This installation cannot find the program that reads its vault, so whether a card is on file is unknown.')
  }
  if (platform === 'linux') return linuxRecordPresence(vaultKey, options)
  if (platform !== 'win32') {
    return answer(null, false, 'VAULT_PLATFORM_UNSUPPORTED', 'This installation has no vault reader for this platform. What it holds is unknown.')
  }
  const lookup = vaultScriptPath(capabilityRoot)
  if (lookup.error) {
    return toolingLookupFailed('whether a card is on file')
  }
  const script = lookup.script
  if (!script) {
    return answer(null, false, 'VAULT_TOOLING_ABSENT', 'This installation cannot find the program that reads its vault, so whether a card is on file is unknown.')
  }

  const store = vaultStorePath(stateRoot)
  const environment = vaultEnvironment(stateRoot)

  let status
  let processError = null
  try {
    await run('powershell.exe', [
      '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', script, 'present', vaultKey,
    ], { env: environment, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true, shell: false, timeout: TIMEOUT_MS })
    status = 0
  } catch (error) {
    processError = error
    status = error && Number.isInteger(error.status) ? error.status : null
  }

  if (status === PRESENT) {
    return answer(true, true, 'VAULT_RECORD_PRESENT', 'A record is on file under this key in this installation’s vault. Nothing about its contents was read.', { store })
  }
  if (status === ABSENT) {
    return answer(false, true, 'VAULT_RECORD_ABSENT', 'This installation’s vault was read and holds no record under this key.', { store })
  }
  if (status === NO_STORE) {
    return answer(false, true, 'VAULT_STORE_ABSENT', 'This installation has no vault store yet, so nothing is on file in it.', { store })
  }
  if (status === UNREADABLE) {
    return answer(null, false, 'VAULT_UNREADABLE', 'This installation’s vault exists but could not be read, so whether a record is on file is unknown. That is not the same as having none.', { store })
  }
  const processCode = processError && typeof processError.code === 'string' ? processError.code.toUpperCase() : ''
  if (processCode === 'ETIMEDOUT' || processError?.killed === true || processError?.signal === 'SIGTERM') {
    return answer(null, false, 'VAULT_TIMEOUT', `This installation’s vault did not answer within ${Math.floor(TIMEOUT_MS / 1000)} seconds, so whether a record is on file is unknown.`, { store })
  }
  if (processCode === 'ENOENT') {
    return answer(null, false, 'VAULT_TOOLING_UNAVAILABLE', 'This installation could not start the program that reads its vault, so whether a record is on file is unknown.', { store })
  }
  /* Every other exit code this file does not know is still UNKNOWN. */
  return answer(null, false, 'VAULT_PROBE_FAILED', 'The program that checks this installation’s vault stopped before answering, so whether a record is on file is unknown.', { store })
}

function unreadableRecords(code, detail, store) {
  return Object.freeze({ readable: false, code, detail, store, values: null, absent: null })
}

/* A CHILD THAT DID NOT ANSWER IS NOT THE SAME THING AS AN ANSWER WE COULD NOT
 * PARSE. Keep the safe process facts and discard everything else: stderr,
 * stdout and error.message may quote a path or a credential, so none of them is
 * inspected or carried. */
function vaultProcessFailure(error, store, subject) {
  const code = error && typeof error.code === 'string' ? error.code.toUpperCase() : ''
  const timedOut = code === 'ETIMEDOUT' || error?.killed === true || error?.signal === 'SIGTERM'
  if (timedOut) {
    return unreadableRecords(
      'VAULT_TIMEOUT',
      `This installation’s vault did not answer within ${Math.floor(TIMEOUT_MS / 1000)} seconds, so ${subject} is unknown.`,
      store,
    )
  }
  if (code === 'ENOENT') {
    return unreadableRecords(
      'VAULT_TOOLING_UNAVAILABLE',
      `This installation could not start the program that reads its vault, so ${subject} is unknown.`,
      store,
    )
  }
  return unreadableRecords(
    'VAULT_READ_FAILED',
    `The program that reads this installation’s vault stopped before answering, so ${subject} is unknown.`,
    store,
  )
}

function invalidVaultResponse(store) {
  return unreadableRecords(
    'VAULT_RESPONSE_INVALID',
    'This installation’s vault answered in a form this program could not read, so what it holds is unknown.',
    store,
  )
}

/**
 * Read the VALUES of named vault records, in one vault process.
 *
 * THE THREE ANSWERS ARE KEPT APART, which is the whole reason this returns a
 * shape rather than a string:
 *
 *   readable: true,  values.has(key)   -- the record is on file and was read
 *   readable: true,  absent includes key -- the vault was read and holds none
 *   readable: false                    -- NOTHING IS KNOWN about any of them
 *
 * The third is not a variant of the second. A locked vault, a vault this
 * Windows account cannot decrypt, a missing helper program and a spawn that
 * never started all land there, and a caller that renders any of them as "you
 * have not set this up" is making a false statement out of a file error. That
 * is the same collapse the presence question above was rebuilt to remove.
 *
 * A vault file that does not exist yet is ABSENT, not unknown -- `Read-Vault`
 * answers an empty store for a missing file, and the presence verb already
 * calls that state a definite "nothing is on file in it".
 *
 * A record holding only whitespace counts as ABSENT. It is not a credential,
 * and calling it present would hand the caller an empty string to sign in with.
 *
 * @param {string[]} vaultKeys record key NAMES. Never values.
 * @param {object} options
 * @param {string} options.capabilityRoot directory holding `tools/secrets.ps1`
 * @param {string} options.stateRoot the state root whose `vault/` is the store
 */
async function vaultRecordValues(vaultKeys, options = {}) {
  const { capabilityRoot, stateRoot, run = execFileAsync, platform = process.platform, principal = null } = options || {}
  const store = vaultStorePath(stateRoot)
  const keys = Array.isArray(vaultKeys) ? vaultKeys : []
  if (keys.length === 0 || keys.some((key) => typeof key !== 'string' || !VAULT_KEY_RE.test(key))) {
    return unreadableRecords('VAULT_KEY_INVALID', 'That is not a vault record this product will ask about.', store)
  }
  /* THE OWNER'S ACCESS DECISIONS ARE CONSULTED BEFORE THE VAULT IS OPENED, not
     after. A refusal here never starts powershell.exe and never reaches the
     store, so a denied record cannot be read and then discarded -- there is no
     moment at which its value exists in this process.
   *
   * `principal` NAMES WHO IS ASKING, and only a read that names one is ruled
   * on. A call with no principal is this installation reading its own
   * credentials to do its own work (shell/google-signin-config.cjs is the
   * caller in this repository); the owner's per-agent switches are about
   * assistants, not about whether the product may sign itself in. Every
   * agent-facing caller MUST pass one -- that is what makes the switch real,
   * and it is asserted in tools/test/vault-presence.test.mjs. */
  if (typeof principal === 'string' && principal) {
    const read = readPolicy(stateRoot)
    const denied = []
    for (const key of keys) {
      const verdict = mayRead(read, key, principal)
      if (!verdict.allowed) denied.push({ key, verdict })
    }
    if (denied.length > 0) {
      /* The refusal names the decision, never the record's value and never the
         other keys in the set: one denied key refuses the whole read, because
         handing back a partial set silently is how a caller ends up using a
         credential it was not given. */
      const first = denied[0]
      return unreadableRecords(first.verdict.code, first.verdict.detail, store)
    }
  }
  if (typeof capabilityRoot !== 'string' || !capabilityRoot) {
    return unreadableRecords('VAULT_TOOLING_ABSENT', 'This installation cannot find the program that reads its vault, so what the vault holds is unknown.', store)
  }
  if (platform === 'linux') return linuxRecordValues(keys, options)
  if (platform !== 'win32') {
    return unreadableRecords('VAULT_PLATFORM_UNSUPPORTED', 'This installation has no vault reader for this platform. What it holds is unknown.', store)
  }
  const lookup = vaultScriptPath(capabilityRoot)
  if (lookup.error) {
    return toolingLookupFailed('what the vault holds', store)
  }
  const script = lookup.script
  if (!script) {
    return unreadableRecords('VAULT_TOOLING_ABSENT', 'This installation cannot find the program that reads its vault, so what the vault holds is unknown.', store)
  }

  /* ONE PROCESS FOR THE WHOLE SET. Every powershell.exe start costs most of a
     second on this machine, and the pair this was built for is always read
     together -- an id without its secret cannot sign anybody in. */
  let raw
  try {
    raw = await run('powershell.exe', [
      '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', script,
      'get-many', '-Keys', keys.join(','),
    ], {
      env: vaultEnvironment(stateRoot),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
      timeout: TIMEOUT_MS,
    })
  } catch (error) {
    /* THE ERROR'S CONTENT IS NOT INSPECTED AND NOT CARRIED. Its `stderr` is the
       one place a vault failure could quote the file it was reading, and this
       function's whole output is destined for a sentence on a screen. The
       classifier reads only code/killed/signal to distinguish timeout and a
       missing executable from another stopped child. */
    return vaultProcessFailure(error, store, 'what it holds')
  }

  let parsed
  try {
    parsed = JSON.parse(String(raw).trim())
  } catch {
    return invalidVaultResponse(store)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return invalidVaultResponse(store)
  }

  const values = new Map()
  const absent = []
  for (const key of keys) {
    const entry = parsed[key]
    /* A SHAPE THIS DOES NOT RECOGNISE IS "THE READ FAILED", NEVER "THE KEY IS
       ABSENT". Guessing absence here is how a configured credential comes to
       look unconfigured, and upstream treats unconfigured as permission to tell
       somebody their setup is missing. */
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return invalidVaultResponse(store)
    }
    if (entry.found === true) {
      if (typeof entry.value !== 'string') {
        return invalidVaultResponse(store)
      }
      const value = entry.value.trim()
      if (value) values.set(key, value)
      else absent.push(key)
    } else if (entry.found === false) {
      absent.push(key)
    } else {
      return invalidVaultResponse(store)
    }
  }
  return Object.freeze({
    readable: true,
    code: 'VAULT_RECORDS_READ',
    detail: 'This installation’s vault was read.',
    store,
    values,
    absent: Object.freeze(absent),
  })
}

/* ------------------------------------------------------------------------
 * WHAT IS IN THE VAULT -- THE NAMES, AND ONLY EVER THE NAMES.
 *
 * WHY THIS IS A THIRD QUESTION AND NOT A VARIANT OF THE OTHER TWO. Both verbs
 * above need the caller to ALREADY KNOW the key: `vaultRecordPresence` asks
 * about one named record, `vaultRecordValues` reads a named set. A Settings
 * page that manages the owner's vault cannot know the keys -- that is the whole
 * question it is asking -- so before this function the main process had no way
 * to answer it. capability/src/lib/runtime.js's `listSecretKeys` asks it on the
 * engine side, and shell/ could not reach that from Electron's main process.
 *
 * THE ANSWER'S SHAPE IS THE FENCE. `names` is the ONLY data field, and the keys
 * of the returned object are pinned by ANSWER_KEYS below. There is deliberately
 * no `values`, no `value`, no `preview`, no `length` and no count of characters
 * anywhere on this path. A masked prefix and a value's length are both partial
 * disclosures of a credential -- a length turns a password into a much smaller
 * search space -- so neither is produced here, and a caller that wanted one
 * would have to add a field this module refuses to carry.
 *
 * IT SPAWNS THE `list` VERB, WHICH CANNOT PRINT A VALUE. tools/secrets.ps1's
 * 'list' writes `(Read-Vault).Keys` minus its own $VaultOracleDenylist and
 * decrypts nothing; its sibling 'get' is the verb that calls
 * Unprotect-CipherText. No branch here names a value-returning verb, and
 * tools/test/vault-credential-page.test.mjs asserts that over the real argv.
 *
 * THE DENYLIST IS NOT WORKED AROUND. Records the vault refuses to confirm the
 * existence of -- the owner's payment card among them -- are omitted by
 * secrets.ps1 itself, so they are absent from this list and this page cannot
 * offer to delete one. That is correct: those have their own paths.
 *
 * AN UNREADABLE VAULT IS `names: null`, NEVER `names: []`. An empty array is a
 * statement that the vault holds nothing, and a file error is not grounds for
 * making it. Rendering "you have no credentials" out of a locked store is the
 * same false sentence the presence question above was rebuilt to remove.
 */
const NAME_ANSWER_KEYS = Object.freeze(['readable', 'code', 'detail', 'store', 'names'])

/* The value-returning verbs of tools/secrets.ps1, named so a change on either
   side is a visible edit to both. Nothing on the name path may spawn one. */
const VALUE_RETURNING_VAULT_VERBS = Object.freeze([
  'get', 'get-many', 'get-or-create-stdin', 'verify',
])

function unreadableNames(code, detail, store) {
  return Object.freeze({ readable: false, code, detail, store, names: null })
}

function invalidVaultNames(store) {
  return unreadableNames(
    'VAULT_RESPONSE_INVALID',
    'This installation’s vault answered in a form this program could not read, so what it holds is unknown.',
    store,
  )
}

/* Key-SHAPED lines only, deduplicated, sorted. The shape is
   tools/secrets.ps1's own key rule, so a line the vault could not have issued
   as a key is dropped rather than shown to the owner as one of his records. */
function keyNamesFrom(listed) {
  const lines = Array.isArray(listed) ? listed : String(listed ?? '').split(/\r?\n/)
  if (lines.some(line => typeof line !== 'string')) return null
  const names = lines.map(line => line.trim()).filter(line => VAULT_KEY_RE.test(line))
  return [...new Set(names)].sort()
}

function readNames(names, store) {
  return Object.freeze({
    readable: true,
    code: 'VAULT_NAMES_READ',
    detail: 'This installation’s vault was read. Only the names of its records were asked for.',
    store,
    names: Object.freeze(names),
  })
}

/**
 * List the NAMES of the records in this installation's vault.
 *
 * @param {object} options
 * @param {string} options.capabilityRoot directory holding `tools/secrets.ps1`
 * @param {string} options.stateRoot the state root whose `vault/` is the store
 * @returns {Promise<{readable: boolean, code: string, detail: string,
 *   store: string|null, names: ReadonlyArray<string>|null}>} never a value.
 */
async function vaultRecordNames(options = {}) {
  const { capabilityRoot, stateRoot, run = execFileAsync, platform = process.platform } = options || {}
  const store = vaultStorePath(stateRoot)
  if (typeof capabilityRoot !== 'string' || !capabilityRoot) {
    return unreadableNames('VAULT_TOOLING_ABSENT', 'This installation cannot find the program that reads its vault, so what the vault holds is unknown.', store)
  }
  if (platform === 'linux') return linuxRecordNames(options)
  if (platform !== 'win32') {
    return unreadableNames('VAULT_PLATFORM_UNSUPPORTED', 'This installation has no vault reader for this platform. What it holds is unknown.', store)
  }
  const lookup = vaultScriptPath(capabilityRoot)
  if (lookup.error) return toolingLookupFailed('what the vault holds', store)
  const script = lookup.script
  if (!script) {
    return unreadableNames('VAULT_TOOLING_ABSENT', 'This installation cannot find the program that reads its vault, so what the vault holds is unknown.', store)
  }

  let raw
  try {
    raw = await run('powershell.exe', [
      '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', script, 'list',
    ], {
      env: vaultEnvironment(stateRoot),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
      timeout: TIMEOUT_MS,
    })
  } catch (error) {
    /* Same rule as the value reader: only code/killed/signal are inspected.
       stderr is the one place a vault failure could quote a path, and this
       answer is destined for a sentence on the owner's screen. */
    const failed = vaultProcessFailure(error, store, 'what it holds')
    return unreadableNames(failed.code, failed.detail, store)
  }

  const names = keyNamesFrom(raw)
  if (!names) return invalidVaultNames(store)
  return readNames(names, store)
}

module.exports = {
  vaultRecordPresence,
  vaultRecordValues,
  vaultRecordNames,
  NAME_ANSWER_KEYS,
  VALUE_RETURNING_VAULT_VERBS,
  PRESENT_EXIT: PRESENT,
  ABSENT_EXIT: ABSENT,
  UNREADABLE_EXIT: UNREADABLE,
  NO_STORE_EXIT: NO_STORE,
}
