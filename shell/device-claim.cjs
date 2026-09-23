'use strict'

/* CONNECTING THIS COMPUTER TO THE PERSON'S ACCOUNT, FROM INSIDE THE APP.
 *
 * WHY THIS FILE EXISTS. Every other piece of the ceremony was already built
 * and already shipped-shaped: the account service opens a claim, mints a code
 * and hands over the machine's credential (POST /v1/devices/claim-code, its
 * /status, and /claim for the person's browser); the website's account page
 * already has the TC-XXXX-XXXX box and the "Add this computer" button; the
 * engine has both the client (src/lib/online-fra-device-claim.js) and a CLI
 * written for exactly this caller (tools/online-fra-claim-cli.js, whose own
 * header says it exists so "the tray, the settings walkthrough and a bare
 * terminal" share ONE implementation). The shell had none of it.
 * relayMachineIsEnrolled() in shell/main.cjs returned a flat false with a TODO
 * naming this work, and because of that one false the relay leg -- shipped,
 * supervised, correct -- has never started on a customer's machine. This is
 * the missing seam, and it is deliberately thin: it starts the CLI and
 * translates its answer. It does not re-implement the claim, and it must not,
 * because a second implementation of a credential ceremony is a second thing
 * that can be subtly wrong.
 *
 * THE POLL TOKEN NEVER CROSSES TO THE RENDERER. openClaim() returns two things
 * a surface needs -- the code to show the person and how long it lives -- and
 * one thing only a machine needs: the poll token that collects the minted
 * credential. That token is bearer-shaped, so whoever holds it collects the
 * grant. begin() therefore keeps it HERE, in main-process memory, and poll()
 * takes no argument at all. A renderer cannot hand back a token it was never
 * given, which means a page that has been taken over cannot collect a claim it
 * did not open. The contract's shape is the guarantee: there is no field in
 * any reply this module produces that the token could travel in.
 *
 * EVERY REPLY IS BUILT FIELD BY FIELD, NEVER SPREAD. connectionState() in the
 * engine returns the device token, the client certificate and its private key
 * alongside the pair id; the CLI's `status` verb already declines to print
 * them, and this module declines a second time by naming the four fields it
 * copies. Two independent refusals, so a future CLI that starts printing more
 * cannot turn a renderer reply into a credential disclosure.
 *
 * REFUSALS ARE OUR SENTENCES, NOT THE CHILD'S. The engine's messages name the
 * vault key, quote fetch's error text, and can carry a hostname or a path.
 * None of it is forwarded. A refusal is a code from CODES below plus a
 * sentence written here, so nothing a child prints can reach a window even if
 * a future child forgets its manners. That is the discipline
 * shell/relay-supervisor.cjs already applies to its own `lastReason`.
 *
 * THE ENVIRONMENT IS THE RELAY LEG'S ALLOWLIST, BY REFERENCE. This child reads
 * the same DPAPI vault through the same PowerShell as the relay leg and talks
 * to the same account service, so it needs exactly what that child needs.
 * relayChildEnvironment() is imported rather than copied: two allowlists that
 * must agree are two allowlists that will eventually differ, and the one that
 * drifts wider is the one nobody looks at. The facade credentials are simply
 * not passed -- a claim is not an agent call and has no business holding the
 * per-boot bearer.
 *
 * THE CHILD IS BOUNDED. A claim CLI that never exits -- a socket that hangs, a
 * PowerShell waiting on something -- must not wedge the shell behind an IPC
 * reply that never comes. Every invocation has a deadline; past it the child
 * is cancelled through its containment owner and the caller gets a bounded
 * DEVICE_CLAIM_TIMEOUT. The lane stays held until the owner proves completion.
 *
 * NOTHING HERE REQUIRES ELECTRON. The owned-spawn seam, payload root, clock
 * and timers are injected, which lets tools/test/device-claim.test.mjs
 * drive hung children, malformed output and a hostile parent environment with
 * no real child and no real sleep.
 */

const fs = require('node:fs')
const path = require('node:path')

/* One definition of the child environment, shared with the relay leg. See the
   header: this is a reuse, not a convenience. */
const { relayChildEnvironment } = require('./relay-supervisor.cjs')
const { CLEANUP_TIMEOUT_MS } = require('./owned-claim-process.cjs')
const { spawnClaimLifetime } = require('./claim-lifetime-process.cjs')
const lifetimeReceipts = require('./claim-lifetime-receipts.cjs')

/* WHERE THE CLAIM CLI IS INSIDE THE PAYLOAD. Declared in
   tools/capability-manifest.json as a `spawnedPrograms` root, which is what
   makes the packer walk its require() graph and stage it. A payload packed
   before that declaration does not contain this file, and this module says so
   (DEVICE_CLAIM_CLI_ABSENT) rather than spawning a path that is not there. */
const adminContract = require('./owner-administration-contract.cjs')
const ADMIN_ERROR_CODES = new Set(['ADMIN_INPUT_INVALID', 'ADMIN_IDENTITY_ABSENT', 'ADMIN_IDENTITY_MISMATCH',
  'ADMIN_CONTEXT_MISMATCH', 'ADMIN_OPERATION_CONFLICT', 'ADMIN_OPERATION_ABSENT', 'ADMIN_REPLY_INVALID',
  'ADMIN_REPLY_EXPIRED', 'ADMIN_CREDENTIAL_CONFLICT', 'ADMIN_CREDENTIAL_CHANGED', 'ADMIN_CONSENT_REQUIRED',
  'ADMIN_NOT_COLLECTED', 'ADMIN_PLATFORM_UNSUPPORTED', 'ADMIN_VAULT_FAILED'])
const ADMIN_ENTRY = path.join('tools', 'online-fra-admin-cli.js')

const CLAIM_ENTRY = path.join('tools', 'online-fra-claim-cli.js')

/* THE CLOSED SET OF REFUSAL CODES. A renderer branches on these, so they are a
   contract: bounded, stable, and free of anything derived from a message. The
   test asserts that every refusal this module can produce is a member. */
const CODES = Object.freeze({
  /* The shell could not even ask. */
  PAYLOAD_ABSENT: 'DEVICE_CLAIM_PAYLOAD_ABSENT',
  CLI_ABSENT: 'DEVICE_CLAIM_CLI_ABSENT',
  PROGRAM_FILES_UNREADABLE: 'DEVICE_CLAIM_PROGRAM_FILES_UNREADABLE',
  STATE_ROOT_UNKNOWN: 'DEVICE_CLAIM_STATE_ROOT_UNKNOWN',
  SPAWN_FAILED: 'DEVICE_CLAIM_SPAWN_FAILED',
  TIMEOUT: 'DEVICE_CLAIM_TIMEOUT',
  BUSY: 'DEVICE_CLAIM_BUSY',
  INVALIDATED: 'DEVICE_CLAIM_INVALIDATED',
  LOCAL_CREDENTIAL_UNAVAILABLE: 'DEVICE_CLAIM_LOCAL_CREDENTIAL_UNAVAILABLE',
  UNREADABLE: 'DEVICE_CLAIM_UNREADABLE',
  OUTPUT_TOO_LARGE: 'DEVICE_CLAIM_OUTPUT_TOO_LARGE',
  NAME_INVALID: 'DEVICE_CLAIM_NAME_INVALID',
  DECISION_INVALID: 'DEVICE_CLAIM_DECISION_INVALID',
  /* The service, or the engine, answered and the answer was a no. */
  GONE: 'DEVICE_CLAIM_GONE',
  ALREADY_CONNECTED: 'DEVICE_CLAIM_ALREADY_CONNECTED',
  UNREACHABLE: 'DEVICE_CLAIM_UNREACHABLE',
  RESPONSE_INVALID: 'DEVICE_CLAIM_RESPONSE_INVALID',
  CREDENTIAL_INVALID: 'DEVICE_CLAIM_CREDENTIAL_INVALID',
  REFUSED: 'DEVICE_CLAIM_REFUSED',
  /* FOUR REFUSALS THAT ARE NOT THE SAME REFUSAL. They all used to arrive as
     REFUSED -- "The account service refused the request." -- which tells a
     person nothing they can act on. Each of these has a different next step,
     and three of the four are not the person's fault at all. */
  TOO_MANY_TRIES: 'DEVICE_CLAIM_TOO_MANY_TRIES',
  SERVICE_BUSY: 'DEVICE_CLAIM_SERVICE_BUSY',
  REGION_REFUSED: 'DEVICE_CLAIM_REGION_REFUSED',
  NOT_OFFERED: 'DEVICE_CLAIM_NOT_OFFERED',
  ALLOWANCE_REACHED: 'DEVICE_CLAIM_ALLOWANCE_REACHED',
  /* The bounded clear code is retained for compatibility. Typed mutation
     outcome and known local cause distinguish actionable vault refusals. */
  DISCONNECT_FAILED: 'DEVICE_CLAIM_DISCONNECT_FAILED',
})
const CODE_VALUES = Object.freeze(Object.values(CODES))

/* THE SENTENCES, written here, one per code. A refusal a person can read is
   the whole point of a bounded code set; a code with no sentence would push
   the wording into a renderer, where three surfaces would each invent their
   own. Nothing in this table interpolates anything. */
const REASONS = Object.freeze({
  [CODES.PAYLOAD_ABSENT]: 'This installation cannot find its own program files, so it cannot connect this computer to an account.',
  [CODES.CLI_ABSENT]: 'This build does not include the program that connects a computer to an account. Updating the app is what fixes it.',
  [CODES.PROGRAM_FILES_UNREADABLE]: 'This installation could not check the program files needed to connect this computer to an account.',
  [CODES.STATE_ROOT_UNKNOWN]: 'This installation does not know where it keeps its own data, so it will not try to connect.',
  [CODES.SPAWN_FAILED]: 'The program that connects this computer to an account could not be started.',
  [CODES.TIMEOUT]: 'The connection step took too long. Its result is uncertain; wait for cleanup before trying again.',
  [CODES.BUSY]: 'This computer is already in the middle of a connection step. Wait for that one to finish.',
  [CODES.INVALIDATED]: 'This connection step was cancelled. Start a fresh connection after cleanup finishes.',
  [CODES.LOCAL_CREDENTIAL_UNAVAILABLE]: 'This computer could not complete the secure credential operation. Check its local credential service before trying again.',
  [CODES.UNREADABLE]: 'The connection step finished but did not answer in a way this app understands.',
  [CODES.OUTPUT_TOO_LARGE]: 'The connection step produced far more output than an answer, so it was stopped.',
  [CODES.NAME_INVALID]: 'That is not a name this computer can be listed under. Use up to 64 ordinary characters.',
  [CODES.DECISION_INVALID]: 'This computer can only accept or decline after an account has asked to claim it.',
  [CODES.GONE]: 'That code is no longer open. It expired, or it was already used. Start again to get a new one.',
  /* "Remove it on the account page first" came off this one. Removing the
     computer there does not clear the credential this machine holds (it is the
     engine's, and no forget path exists yet), so that advice sent people to do
     a thing that does not cure the refusal. The diagnosis stays; the remedy is
     the flow's (src/device-claim-flow.js, ALREADY_CONNECTED_REMEDY). */
  [CODES.ALREADY_CONNECTED]: 'This computer already holds a connection to an account, so it cannot take a new code.',
  [CODES.UNREACHABLE]: 'The account service did not return a complete response. The request may have reached it. Check the current connection state before repeating the step.',
  [CODES.RESPONSE_INVALID]: 'The account service returned an incomplete or unreadable response. This connection step may have taken effect. Check the current connection state before repeating it.',
  [CODES.CREDENTIAL_INVALID]: 'What this computer holds for its account is not readable. Connect this computer again.',
  [CODES.REFUSED]: 'The account service refused the request.',
  [CODES.TOO_MANY_TRIES]: 'This computer has asked to connect too many times in a row. Wait about ten minutes and try again — nothing is wrong with your account.',
  [CODES.SERVICE_BUSY]: 'The account service is busy and could not start a connection just now. Try again in a few minutes; this is us, not you.',
  [CODES.REGION_REFUSED]: 'ToolsEnabled cannot connect a computer from this country yet. Nothing is wrong with your account.',
  [CODES.NOT_OFFERED]: 'This account service is not set up to connect computers by code. If you are pointing the app somewhere other than toolsenabled.ai, that is why.',
  [CODES.ALLOWANCE_REACHED]: 'That account has no room for another hosted computer. Make room on its account page, then choose again here.',
  [CODES.DISCONNECT_FAILED]: 'This computer could not confirm that its account connection was cleared.',
})

const LOCAL_CLEAR_REASONS = Object.freeze({
  SECRET_BACKEND_LOCKED: 'Unlock this computer’s keyring, then try again.',
  SECRET_BACKEND_UNAVAILABLE: 'This computer’s secure credential service is unavailable. Restore the service, then try again.',
  SECRET_BACKEND_KEY_MISSING: 'This computer’s credential encryption key is missing. Keep the existing encrypted data and use supported recovery.',
  SECRET_BACKEND_KEY_INVALID: 'This computer’s credential encryption key is not usable. Keep the existing encrypted data and use supported recovery.',
})
const LOCAL_CLEAR_CAUSES = new Set([
  ...Object.keys(LOCAL_CLEAR_REASONS), 'SECRET_HELPER_PROTOCOL_INVALID',
  'SECRET_VAULT_WRITE_UNCERTAIN', 'SECRET_BACKEND_UNSAFE', 'SECRET_BACKEND_IDENTITY_INVALID',
  'SECRET_VAULT_FORMAT_UNSUPPORTED', 'SECRET_VAULT_UNREADABLE', 'SECRET_VAULT_WRITE_FAILED',
  'SECRET_VAULT_PATH_UNSAFE', 'SECRET_VAULT_LOCK_TIMEOUT', 'SECRET_ACCESS_DENIED',
  'SECRET_NOT_CONFIGURED', 'SECRET_INPUT_INVALID', 'SECRET_MONOTONIC_CONFLICT',
  'SECRET_PAYMENT_CARD_REVIEW_REQUIRED', 'SECRET_HELPER_UNAVAILABLE',
])

function clearFailure(result) {
  const knownCause = LOCAL_CLEAR_CAUSES.has(result.localCause)
  const localCause = knownCause
    ? result.localCause : 'SECRET_HELPER_PROTOCOL_INVALID'
  return Object.freeze({ ok: false, code: CODES.DISCONNECT_FAILED,
    reason: LOCAL_CLEAR_REASONS[localCause] || REASONS[CODES.DISCONNECT_FAILED],
    mutationOutcome: knownCause && result.mutationOutcome === 'NOT_ATTEMPTED' ? 'NOT_ATTEMPTED' : 'UNCERTAIN',
    localCause })
}

/* THE ENGINE ERROR CODES THIS MODULE PASSES THROUGH BY NAME. Anything the
   child names that is not on this map becomes REFUSED: an unbounded code set
   is a renderer branching on a string it has never seen, and a code invented
   by a dependency is exactly how a message leaks through a field everybody
   believed was an enum. */
const CHILD_CODE_MAP = Object.freeze({
  DEVICE_CLAIM_GONE: CODES.GONE,
  DEVICE_CLAIM_ALREADY_CONNECTED: CODES.ALREADY_CONNECTED,
  DEVICE_CLAIM_UNREACHABLE: CODES.UNREACHABLE,
  DEVICE_CLAIM_RESPONSE_INVALID: CODES.RESPONSE_INVALID,
  DEVICE_CLAIM_CREDENTIAL_INVALID: CODES.CREDENTIAL_INVALID,
  DEVICE_CLAIM_CONFIG_INVALID: CODES.REFUSED,
  DEVICE_CLAIM_REFUSED: CODES.REFUSED,
  CLI_USAGE: CODES.REFUSED,
  CLI_FAILED: CODES.REFUSED,
  /* THE ACCOUNT SERVICE'S OWN CODES, WHICH REACH THIS TABLE UNCHANGED.
     online-fra-device-claim.js forwards `body.error.code` verbatim when a claim
     is refused, so what arrives here is the service's word, not the engine's.
     None of these five were in this table, so all five became REFUSED and the
     person was told "the account service refused the request" whether they had
     tried too often, whether the service was overloaded, or whether we cannot
     serve their country at all -- three different answers with three different
     next steps, and only one of them anything they did.
     The CODE is what is mapped; the service's SENTENCE is still thrown away, as
     translateChildError says and means. Text from a remote service must not
     render in this window, and these sentences are ours. */
  RATE_LIMITED: CODES.TOO_MANY_TRIES,
  CLAIM_CAPACITY: CODES.SERVICE_BUSY,
  REGION_REFUSED: CODES.REGION_REFUSED,
  NO_DEVICE_CLAIMS: CODES.NOT_OFFERED,
  CLAIM_UNKNOWN: CODES.GONE,
  HOSTED_ALLOWANCE_REACHED: CODES.ALLOWANCE_REACHED,
})

/* HOW LONG EACH VERB MAY TAKE. `status` is a vault read: the engine's runtime
   spawns PowerShell for it, measured at just under a second on the owner's
   machine, and fifteen seconds is the same ceiling shell/vault-presence.cjs
   puts on the same kind of question. `open` and `poll` each make one HTTP call
   whose own client aborts at fifteen seconds, so the shell's deadline has to
   be longer than the child's -- otherwise the shell always wins the race and
   reports a timeout for what the service actually called a refusal. */
const STATUS_TIMEOUT_MS = 15_000
const NETWORK_TIMEOUT_MS = 30_000

/* How long a signalled child gets before it is killed outright. The same five
   seconds the relay supervisor's stop() allows, for the same reason: a
   deadline that itself has no deadline is not a deadline. */
const KILL_ESCALATION_MS = 5_000

/* A ceiling on what is read from the child's stdout. The contract is one JSON
   object; anything approaching this is a child that has lost its manners, and
   reading it to the end would let a broken program grow the shell's heap. */
const MAX_STDOUT_BYTES = 64 * 1024

/* What a computer may be called on the account page. Bounded because it
   becomes an argv value and a row in someone's device list. Control characters
   are refused rather than stripped, so a person sees that their name was not
   accepted instead of silently getting a different one. A leading double dash
   is refused because the CLI reads its arguments by flag name, and a "name"
   that looks like a flag is a question about intent rather than a name. */
const MAX_NAME_LENGTH = 64
const NAME_REFUSED_RE = /[\u0000-\u001f\u007f]/

function refusal(code) {
  return Object.freeze({ ok: false, code, reason: REASONS[code] || REASONS[CODES.REFUSED] })
}

function requireFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`createDeviceClaim requires ${name}`)
  }
  return value
}

function validName(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_NAME_LENGTH) return null
  if (NAME_REFUSED_RE.test(trimmed)) return null
  if (trimmed.startsWith('--')) return null
  return trimmed
}

/* THE ONE OBJECT ON STDOUT, FOUND WITHOUT TRUSTING THE STREAM'S SHAPE. The CLI
   writes exactly one line and everything human goes to stderr, so in practice
   the first line is the answer. The LAST parseable line is taken anyway,
   because the failure worth guarding against is a dependency that logs BEFORE
   the answer -- a module printing after a verb returned would be a child that
   answered twice, which the CLI's control flow cannot do. */
function parseChildAnswer(text) {
  const lines = String(text || '').split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim()
    if (!line) continue
    let parsed
    try { parsed = JSON.parse(line) } catch { continue }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  }
  return null
}

/* The child's own refusal, translated. `message` is read only to be thrown
   away: the code decides everything and the sentence comes from our table. */
function translateChildError(answer) {
  const raw = answer && answer.error && typeof answer.error.code === 'string' ? answer.error.code : null
  const code = (raw && CHILD_CODE_MAP[raw]) || CODES.REFUSED
  if (raw === 'DEVICE_CREDENTIAL_CLEAR_FAILED') return clearFailure(answer.error)
  if (code === CODES.UNREACHABLE || code === CODES.RESPONSE_INVALID) {
    // A missing or future outcome cannot establish that dispatch was avoided.
    // Keep this network result distinct from a local vault mutation outcome.
    const requestOutcome = code === CODES.UNREACHABLE && answer.error.requestOutcome === 'NOT_ATTEMPTED' ? 'NOT_ATTEMPTED' : 'UNCERTAIN'
    return Object.freeze({ ...refusal(code), requestOutcome,
      reason: requestOutcome === 'NOT_ATTEMPTED'
        ? 'This computer did not send the account request. Check its connection settings before trying again.'
        : REASONS[code] })
  }
  if (raw && raw.startsWith('SECRET_')) {
    const localCause = LOCAL_CLEAR_CAUSES.has(raw) ? raw : 'SECRET_HELPER_PROTOCOL_INVALID'
    return Object.freeze({ ok: false, code: CODES.LOCAL_CREDENTIAL_UNAVAILABLE, localCause,
      reason: LOCAL_CLEAR_REASONS[localCause] || REASONS[CODES.LOCAL_CREDENTIAL_UNAVAILABLE] })
  }
  return refusal(code)
}

/**
 * The shell's half of the device claim.
 *
 * @param {object} deps
 * @param {Function} deps.spawn               child_process.spawn, or a stand-in
 * @param {Function} deps.resolvePayloadRoot  answers the staged payload's root, or null
 * @param {Function} [deps.log]               one line of identifier-free progress
 * @param {Function} [deps.now]               the clock, injected so expiry is testable
 * @param {string}   [deps.stateRoot]         stated rather than inherited
 * @param {string}   [deps.accountOrigin]     a non-production account service, when there is
 *                                            one. Deliberately NOT on the shared allowlist --
 *                                            see relay-supervisor.cjs.
 */
function createDeviceClaim({
  spawn,
  spawnOwned = spawnClaimLifetime,
  onOwnershipStart = () => false,
  onOwnershipComplete = () => {},
  resolvePayloadRoot,
  log = () => {},
  now = Date.now,
  execPath = process.execPath,
  env = process.env,
  exists = fs.existsSync,
  stateRoot = undefined,
  accountOrigin = '',
  statusTimeoutMs = STATUS_TIMEOUT_MS,
  networkTimeoutMs = NETWORK_TIMEOUT_MS,
  cleanupTimeoutMs = CLEANUP_TIMEOUT_MS,
  setTimeout: schedule = setTimeout,
  clearTimeout: cancelTimer = clearTimeout,
} = {}) {
  requireFunction(spawn, 'spawn')
  requireFunction(resolvePayloadRoot, 'resolvePayloadRoot')

  /* Stated by the caller, or the value this process was started with. A
     relative one is refused rather than resolved against a working directory
     nobody chose -- the same rule the relay supervisor applies, and for the
     same reason: two half-populated state roots is how a credential lands
     somewhere the relay leg will never look. */
  const resolvedStateRoot = typeof stateRoot === 'string' && stateRoot
    ? stateRoot
    : (env && typeof env.TOOLSENABLED_STATE_ROOT === 'string' ? env.TOOLSENABLED_STATE_ROOT : '')

  /* THE POLL TOKEN'S ONLY HOME. Held by begin(), read by poll(), cleared by
     cancel() and by any answer that ends the claim. It is never returned,
     never logged and never put in a reply -- see the header. */
  let pending = null

  /* One child at a time. Two claim CLIs racing on one vault is a question
     nobody needs answered, and a renderer firing poll() on a timer while a
     begin() is still in flight would produce exactly that. The refusal is
     named, so the surface can simply wait. */
  let inFlight = null
  let generation = 0
  let enrollmentFenced = false
  let disconnecting = false
  let operationInFlight = false
  let adminFinalReceipt = null

  // Keep the operation reserved until its answer has updated pending state.
  // Native completion can arrive before that JavaScript continuation runs.
  async function withOperation(action) {
    if (operationInFlight || inFlight || disconnecting) return refusal(CODES.BUSY)
    operationInFlight = true
    try { return await action() }
    catch { return refusal(CODES.UNREADABLE) }
    finally { operationInFlight = false }
  }

  /* WHAT THE VAULT LAST SAID, so relayMachineIsEnrolled() can answer without
     awaiting a spawn. It starts false: a shell that has not yet asked has not
     been told this machine is connected, and starting a relay leg on that
     basis would be a guess dressed as a fact.

     A REFUSAL DOES NOT MOVE IT. "I could not read the vault" is not evidence
     that the credential is gone -- that is shell/vault-presence.cjs's rule and
     it holds here for the same reason: an unreadable vault must not look like
     a machine somebody disconnected. Only an answer moves this. */
  let lastKnownConnected = false

  function payloadEntry(relativeEntry = CLAIM_ENTRY) {
    let root
    try { root = resolvePayloadRoot() } catch {
      return { ok: false, code: CODES.PROGRAM_FILES_UNREADABLE }
    }
    if (typeof root !== 'string' || !root) return { ok: false, code: CODES.PAYLOAD_ABSENT }
    const entry = path.join(root, relativeEntry)
    let present
    try { present = exists(entry) } catch {
      return { ok: false, code: CODES.PROGRAM_FILES_UNREADABLE }
    }
    if (!present) return { ok: false, code: CODES.CLI_ABSENT }
    if (!resolvedStateRoot || !path.isAbsolute(resolvedStateRoot)) {
      return { ok: false, code: CODES.STATE_ROOT_UNKNOWN }
    }
    return { ok: true, entry, root }
  }

  function childEnvironment() {
    const environment = relayChildEnvironment(env, { stateRoot: resolvedStateRoot })
    /* Set explicitly rather than inherited. The shared allowlist deliberately
       does not carry this name, so a developer's ambient value cannot point a
       customer's claim at a service nobody chose. */
    if (typeof accountOrigin === 'string' && accountOrigin) {
      environment.TOOLSENABLED_ACCOUNT_ORIGIN = accountOrigin
    }
    return environment
  }

  /* Run one verb and answer with its one JSON object, or with a named refusal.
     Resolves; never rejects. Every caller below is behind an IPC handler, and
     an IPC handler that throws hands the renderer an Error carrying whatever
     text happened to be in it. */
  function runVerb(args, timeoutMs, { input, entry = CLAIM_ENTRY, administrative = false } = {}) {
    if (inFlight) return Promise.resolve(refusal(CODES.BUSY))
    const resolved = payloadEntry(entry)
    if (!resolved.ok) return Promise.resolve({ ...refusal(resolved.code), mutationOutcome: 'NOT_ATTEMPTED' })

    let owned
    try {
      owned = spawnOwned({ spawn, command: execPath, args: [resolved.entry, ...args],
        payloadRoot: resolved.root, stateRoot: resolvedStateRoot,
        environment: childEnvironment(), input, cleanupTimeoutMs, onOwnershipStart, onOwnershipComplete })
    } catch {
      return Promise.resolve({ ...refusal(CODES.SPAWN_FAILED), mutationOutcome: 'NOT_ATTEMPTED' })
    }
    const flight = { owned, completion: null }
    inFlight = flight
    return new Promise(resolve => {
      let settled = false
      const stdout = []
      let bytes = 0
      const finish = value => {
        if (settled) return
        settled = true
        cancelTimer(deadline)
        resolve(value)
      }
      const stop = () => { try { Promise.resolve(owned.cancel()).catch(() => {}) } catch {} }
      const uncertain = code => ({ ...refusal(code), mutationOutcome: 'UNCERTAIN' })
      const deadline = schedule(() => {
        log('the connect step passed its deadline; owned cleanup is required')
        stop()
        finish(uncertain(CODES.TIMEOUT))
      }, timeoutMs)
      const child = owned.child
      child.stdout?.on('data', chunk => {
        if (settled) return
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        bytes += data.length
        if (bytes > MAX_STDOUT_BYTES) {
          stop()
          finish(uncertain(CODES.OUTPUT_TOO_LARGE))
        } else stdout.push(data)
      })
      child.stderr?.on('data', () => {})
      child.on('error', () => {})

      flight.completion = Promise.resolve(owned.completion).then(receipt => {
        /* Only an observed empty owner releases the slot. A caller timeout,
           CLI exit, EOF, or missing owner receipt does not. */
        if (receipt?.quiescent === true && inFlight === flight) inFlight = null
        if (!receipt?.quiescent) {
          finish(uncertain(CODES.UNREADABLE))
          return Object.freeze({ quiescent: false })
        }
        if (receipt.started === false) {
          finish({ ...refusal(CODES.SPAWN_FAILED), mutationOutcome: 'NOT_ATTEMPTED' })
          return Object.freeze({ quiescent: true })
        }
        const answer = parseChildAnswer(Buffer.concat(stdout).toString('utf8'))
        if (!receipt.exitedNormally || !answer) {
          finish(uncertain(CODES.UNREADABLE))
        } else if (administrative && answer.ok !== true) {
          finish({ ...refusal(CODES.REFUSED),
            administrativeCause: ADMIN_ERROR_CODES.has(answer.code) ? answer.code : 'ADMIN_VAULT_FAILED',
            mutationOutcome: answer.mutationOutcome === 'NOT_ATTEMPTED' ? 'NOT_ATTEMPTED' : 'UNCERTAIN' })
        } else if (answer.error) {
          finish(translateChildError(answer))
        } else if (receipt.exitCode !== 0) {
          finish(uncertain(CODES.UNREADABLE))
        } else {
          finish({ ok: true, answer })
        }
        return Object.freeze({ quiescent: true })
      }, () => {
        finish(uncertain(CODES.UNREADABLE))
        return Object.freeze({ quiescent: false })
      })
    })
  }

  function invalidateForDisconnect() {
    generation += 1
    adminFinalReceipt = null
    pending = null
    lastKnownConnected = false
    enrollmentFenced = true
    const flight = inFlight
    if (!flight) return Promise.resolve(Object.freeze({ quiescent: true }))
    try { Promise.resolve(flight.owned.cancel()).catch(() => {}) } catch {}
    return new Promise(resolve => {
      let settled = false
      const finish = quiescent => {
        if (settled) return
        settled = true
        cancelTimer(timer)
        resolve(Object.freeze({ quiescent }))
      }
      const timer = schedule(() => finish(false), cleanupTimeoutMs)
      Promise.resolve(flight.completion).then(value => finish(value?.quiescent === true), () => finish(false))
    })
  }

  function invalidated(epoch) { return epoch !== generation }

  /* The four fields a surface may know about a connected machine, copied by
     name. The engine's credential record also holds a device token, a client
     certificate and its private key; none of them has a line here. */
  function connectedReply(answer) {
    return Object.freeze({
      ok: true,
      connected: true,
      name: typeof answer.name === 'string' ? answer.name : '',
      deviceId: typeof answer.deviceId === 'string' ? answer.deviceId : '',
      pairId: typeof answer.pairId === 'string' ? answer.pairId : '',
      claimedAtMs: Number.isFinite(answer.claimedAtMs) ? answer.claimedAtMs : null,
    })
  }

  /* THE ONE STATUS READ EVERY ASKER SHARES.
   *
   * THE DEFECT THIS CLOSES, and it is the worst thing the connect screen did.
   * `runVerb` allows one child at a time and refuses the second with
   * DEVICE_CLAIM_BUSY -- correct for anything that WRITES. But status is a
   * read, its own comment two lines down says it is "safe to call at any
   * cadence from any surface", and two callers ask it during the same two
   * seconds of every launch: shell/main.cjs awaits one before deciding whether
   * to start the relay leg, and the renderer fires one the moment the connect
   * section mounts. Whichever lost the race was told "This computer is already
   * in the middle of a connection step. Wait for that one to finish." -- drawn
   * as a red alert on a sterile profile, about a step nobody had started, on
   * the most important screen in the product. Three scouts reproduced it
   * independently, roughly eight opens in fourteen.
   *
   * A SECOND ASKER NOW JOINS THE ANSWER instead of being refused. Nothing is
   * cached beyond the flight: the moment the spawn settles the slot is empty
   * again, so this is strictly "do not ask the same question twice at once"
   * and never "remember what the vault said". A stale answer here would be the
   * defect wearing the opposite face. */
  let statusInFlight = null

  const api = {
    // Main-only administrative operation. It shares the exact claim owner and
    // generation; a successful CLI line without an empty signed owner is inert.
    async administer(action, trustedInput) {
      return withOperation(async () => {
        if (pending || !adminContract.ACTIONS.has(action)) return refusal(CODES.BUSY)
        const epoch = generation
        let normalized
        try {
          normalized = adminContract.context(trustedInput.context, resolvedStateRoot, action === 'identity')
        } catch { return refusal(CODES.REFUSED) }
        if (!['pair-request', 'identity'].includes(action)) {
          enrollmentFenced = true
          lastKnownConnected = false
          adminFinalReceipt = null
        }
        let capabilityDigest
        if (action === 'pair-request') {
          if (trustedInput.webDriveEnabled !== true || typeof trustedInput.consentStillEnabled !== 'function'
              || trustedInput.consentStillEnabled() !== true) return refusal(CODES.REFUSED)
          const observed = await runVerb([], networkTimeoutMs, { entry: ADMIN_ENTRY, administrative: true,
            input: JSON.stringify({ version: 1, action: 'resume', context: normalized }) })
          if (invalidated(epoch)) return refusal(CODES.INVALIDATED)
          if (!observed.ok) return observed
          try {
            const current = adminContract.answer(observed.answer, normalized, 'resume')
            if (current.stage !== 'stored') return refusal(CODES.REFUSED)
            capabilityDigest = adminContract.pairDigest(current.receipt.pairId)
          } catch { return refusal(CODES.UNREADABLE) }
        }
        let input
        try { input = JSON.stringify({ version: 1, action, context: normalized,
          ...(['import', 'finalize'].includes(action) ? { reply: trustedInput.reply } : {}),
          ...(action === 'pair-request' ? { webDriveEnabled: trustedInput.webDriveEnabled === true, capabilityDigest } : {}) }) }
        catch { return refusal(CODES.REFUSED) }
        if (Buffer.byteLength(input) > 65536) return refusal(CODES.OUTPUT_TOO_LARGE)
        if (action === 'pair-request' && trustedInput.consentStillEnabled() !== true) return refusal(CODES.REFUSED)
        const result = await runVerb([], networkTimeoutMs, { input, entry: ADMIN_ENTRY, administrative: true })
        if (invalidated(epoch)) return refusal(CODES.INVALIDATED)
        if (!result.ok) return result
        let answer
        try { answer = adminContract.answer(result.answer, normalized, action) }
        catch { return { ...refusal(CODES.UNREADABLE), mutationOutcome: 'UNCERTAIN' } }
        if (action === 'pair-request' && trustedInput.consentStillEnabled() !== true) return refusal(CODES.REFUSED)
        if (action === 'finalize') adminFinalReceipt = answer.receipt
        return answer
      })
    },
    completeAdministration(receipt) {
      if (inFlight || operationInFlight || disconnecting || !adminFinalReceipt || receipt !== adminFinalReceipt) return false
      lastKnownConnected = true
      enrollmentFenced = false
      adminFinalReceipt = null
      return true
    },

    /* Is this computer connected to an account? A read: it starts nothing on
       the account side, and it is safe to call at any cadence from any
       surface. */
    status() {
      if (disconnecting) return Promise.resolve(refusal(CODES.BUSY))
      if (statusInFlight) return statusInFlight
      const epoch = generation
      statusInFlight = withOperation(async () => {
        const result = await runVerb(['status'], statusTimeoutMs)
        if (invalidated(epoch)) return refusal(CODES.INVALIDATED)
        if (!result.ok) return result
        if (typeof result.answer.connected !== 'boolean') return refusal(CODES.UNREADABLE)
        const connected = result.answer.connected === true
        lastKnownConnected = connected && !enrollmentFenced
        if (!connected) return Object.freeze({ ok: true, connected: false })
        return connectedReply(result.answer)
      })
      /* Cleared on settle, not by the awaiter, so a caller that walks away
         mid-flight cannot leave the slot held by a promise nobody is reading. */
      const clear = () => { statusInFlight = null }
      statusInFlight.then(clear, clear)
      return statusInFlight
    },

    /* Open a claim and return the code the person types on the account page.
       The poll token that arrives in the same object from the CLI stops
       here. */
    async begin(request) {
      return withOperation(async () => {
      if (disconnecting) return refusal(CODES.BUSY)
      const epoch = generation
      /* THE EXISTING BEGIN CHANNEL IS THE ONLY RENDERER-TO-MACHINE CALL THAT
         CARRIES A REQUEST. A reservation decision uses that already-guarded
         channel rather than adding a second IPC route for the same ceremony.
         It is accepted only after a poll has exposed an account address, and
         only as a literal boolean: absence is an ordinary new claim, while no
         truthy/falsy coercion can turn a malformed request into consent. */
      if (request && Object.prototype.hasOwnProperty.call(request, 'accept')) {
        if (typeof request.accept !== 'boolean' || !pending || pending.stage !== 'reserved') {
          return refusal(CODES.DECISION_INVALID)
        }
        if (pending.expiresAtMs !== null && now() >= pending.expiresAtMs) {
          pending = null
          return refusal(CODES.GONE)
        }
        const accept = request.accept
        const claimRecord = pending
        /* Mark the request as a decision before it leaves. In particular, an
           ordinary poll after an acceptance response was lost must ask the
           service and collect the parked grant; it must not be answered from
           the cached reservation and strand the credential. A poll that finds
           the reservation still there restores the question without accepting
           it. */
        pending.stage = accept ? 'accepting' : 'declining'
        const result = await runVerb([
          'poll', '--token', pending.pollToken, '--accept', accept ? 'true' : 'false',
        ], networkTimeoutMs)
        if (invalidated(epoch) || pending !== claimRecord) return refusal(CODES.INVALIDATED)
        if (!result.ok) {
          /* A failed accept is ambiguous once the request was on the wire. The
             next argument-free poll is the recovery step the server contract
             preserves. A failed decline is treated the same way; if it landed,
             the uniform unknown answer is translated to `rejected` below. */
          return result
        }
        const answer = result.answer
        if (accept && answer.state === 'accepted') {
          pending.stage = 'collecting'
          log('the account was accepted; this computer is collecting its connection')
          return Object.freeze({
            ok: true,
            state: 'accepted',
            intervalSeconds: Number.isFinite(answer.intervalSeconds) ? answer.intervalSeconds : 1,
          })
        }
        if (!accept && answer.state === 'rejected') {
          pending = null
          log('the account was declined; nothing was added')
          return Object.freeze({ ok: true, state: 'rejected' })
        }
        /* The old claim CLI ignores --accept and reports the reservation again.
           That is not a successful decision and must never be painted as one. */
        pending.stage = 'reserved'
        return refusal(CODES.UNREADABLE)
      }

      const name = validName(request && request.name)
      if (!name) return refusal(CODES.NAME_INVALID)
      if (pending) return refusal(CODES.BUSY)
      const result = await runVerb(['open', '--name', name], networkTimeoutMs)
      if (invalidated(epoch)) return refusal(CODES.INVALIDATED)
      if (!result.ok) return result
      const answer = result.answer
      if (typeof answer.code !== 'string' || typeof answer.pollToken !== 'string') {
        /* A claim without a code is nothing to show, and a claim without a
           token is nothing to collect. Either way there is no claim in flight,
           so nothing is remembered. */
        return refusal(CODES.UNREADABLE)
      }
      pending = {
        pollToken: answer.pollToken,
        expiresAtMs: Number.isFinite(answer.expiresAtMs) ? answer.expiresAtMs : null,
        stage: 'pending',
        accountEmail: null,
      }
      log('a claim is open; this computer is waiting for the account page')
      return Object.freeze({
        ok: true,
        code: answer.code,
        expiresAtMs: pending.expiresAtMs,
        intervalSeconds: Number.isFinite(answer.intervalSeconds) ? answer.intervalSeconds : 5,
      })
      })
    },

    /* One question, asked with the token this process is holding. `none` means
       nothing is in flight -- a distinct answer from `pending`, because a
       surface that cannot tell them apart shows a spinner forever. */
    async poll() {
      return withOperation(async () => {
      if (disconnecting) return refusal(CODES.BUSY)
      const epoch = generation
      if (!pending) return Object.freeze({ ok: true, state: 'none' })
      const claimRecord = pending
      // A submitted decision must remain recoverable after the original code
      // expires; only an unanswered code or reservation can expire locally.
      if (['pending', 'reserved'].includes(pending.stage)
          && pending.expiresAtMs !== null && now() >= pending.expiresAtMs) {
        pending = null
        return refusal(CODES.GONE)
      }
      /* A reservation is a question, not progress. Once it has been shown, an
         argument-free poll (including the mount-time poll after a reload) only
         repeats the same question from memory. The only transition out is the
         literal boolean handled by begin() above. */
      if (pending.stage === 'reserved') {
        return Object.freeze({
          ok: true,
          state: 'reserved',
          account: Object.freeze({ email: pending.accountEmail }),
        })
      }
      /* An expired claim is answered without asking anybody. The service would
         say the same thing (404 -> DEVICE_CLAIM_GONE) and this saves a spawn,
         but the reason it is here is that the token is dead either way, and a
         dead token must not outlive the claim it belonged to. */
      const result = await runVerb(['poll', '--token', pending.pollToken], networkTimeoutMs)
      if (invalidated(epoch) || pending !== claimRecord) return refusal(CODES.INVALIDATED)
      if (!result.ok) {
        /* A claim the service says is gone can never be collected, so the token
           is dropped here rather than left for a surface to retry with. Every
           other refusal -- unreachable, busy, a timeout -- leaves the claim in
           flight, because the person's code is still on their screen and still
           good. */
        if (result.code === CODES.GONE) {
          if (pending.stage === 'declining') {
            pending = null
            return Object.freeze({ ok: true, state: 'rejected' })
          }
          pending = null
        }
        return result
      }
      const answer = result.answer
      if (answer.state === 'connected') {
        pending = null
        lastKnownConnected = true
        enrollmentFenced = false
        log('this computer is connected to an account')
        return Object.freeze({
          ok: true,
          state: 'connected',
          /* The CLI reports the grant flat; the contract both halves of this
             seam were built against nests it. Mapped by name, which is also
             what keeps a future extra field out of the renderer. */
          device: Object.freeze({
            name: typeof answer.name === 'string' ? answer.name : '',
            deviceId: typeof answer.deviceId === 'string' ? answer.deviceId : '',
            pairId: typeof answer.pairId === 'string' ? answer.pairId : '',
          }),
        })
      }
      if (answer.state === 'pending') {
        pending.stage = 'pending'
        pending.accountEmail = null
        return Object.freeze({
          ok: true,
          state: 'pending',
          intervalSeconds: Number.isFinite(answer.intervalSeconds) ? answer.intervalSeconds : 5,
        })
      }
      if (answer.state === 'reserved') {
        const email = answer.account && typeof answer.account.email === 'string'
          ? answer.account.email
          : null
        if (email === null || email.length === 0) return refusal(CODES.UNREADABLE)
        pending.stage = 'reserved'
        pending.accountEmail = email
        log('an account is asking to claim this computer; a local decision is required')
        return Object.freeze({
          ok: true,
          state: 'reserved',
          /* Remote display text is copied by name and never interpreted here.
             The renderer escapes it before placing it in markup. */
          account: Object.freeze({ email }),
        })
      }
      /* `wait`'s timeout state, or anything a future CLI invents. Not guessed
         at: an unrecognised state is an answer this shell cannot act on. */
      return refusal(CODES.UNREADABLE)
      })
    },

    /* The person changed their mind. Nothing is told to the service -- there is
       no cancel endpoint and the claim expires on its own -- but the token
       stops existing here, which is the half that matters: this computer will
       not collect a credential nobody is waiting for. */
    cancel() {
      if (operationInFlight || inFlight || disconnecting) return refusal(CODES.BUSY)
      /* Once an account identity is on the question, locally forgetting the
         token is not a decline: it leaves the server-side reservation alive.
         Refuse that stale route so only the explicit false decision can spend
         the reservation and say that nothing was added. */
      if (pending && ['reserved', 'accepting', 'collecting', 'declining'].includes(pending.stage)) return refusal(CODES.DECISION_INVALID)
      /* WHETHER THERE WAS ANYTHING TO GIVE UP IS REPORTED, because the surface
         cannot see this variable and the difference matters to a person. Every
         "Get a code" is routed through cancel-then-begin now (a second press
         used to open a second live claim and orphan the first token), so most
         of these find nothing and must stay silent; the one that DID drop a
         live claim owes the person a sentence, because the code it dropped may
         already be typed into their browser. */
      const dropped = pending !== null
      pending = null
      generation += 1
      if (inFlight) {
        try { Promise.resolve(inFlight.owned.cancel()).catch(() => {}) } catch {}
      }
      return Object.freeze({ ok: true, dropped })
    },

    /* Disconnect intent immediately fences enrollment and invalidates pending
       claims. Wait for the preceding owned tree before starting the local
       clear, then require that mutation's own completion and typed receipt.
       Unknown completion stays fenced; status is informational until a fresh
       explicit claim succeeds. The account's remote device row is unchanged. */
    async disconnect() {
      if (disconnecting) return refusal(CODES.BUSY)
      disconnecting = true
      try {
        const previous = await invalidateForDisconnect()
        if (!previous.quiescent) return clearFailure({ mutationOutcome: 'UNCERTAIN' })
        const epoch = generation
        const result = await runVerb(['disconnect'], statusTimeoutMs)
        if (invalidated(epoch)) return clearFailure({ mutationOutcome: 'UNCERTAIN' })
        if (!result.ok) {
          if (result.code === CODES.DISCONNECT_FAILED) return result
          if (result.mutationOutcome === 'NOT_ATTEMPTED') return result
          return clearFailure(result)
        }
        const answer = result.answer
        if (answer.cleared !== true || typeof answer.wasConnected !== 'boolean'
            || !['REMOVED_SYNCED', 'NOT_ATTEMPTED'].includes(answer.mutationOutcome)
            || (answer.mutationOutcome === 'NOT_ATTEMPTED' && answer.wasConnected)) {
          return clearFailure({ mutationOutcome: 'UNCERTAIN' })
        }
        log('the local account connection clear completed')
        return Object.freeze({ ok: true, wasConnected: answer.wasConnected,
          mutationOutcome: answer.mutationOutcome })
      } finally {
        disconnecting = false
      }
    },

    invalidateForDisconnect,

    reconcileOwnership(descriptor) {
      return lifetimeReceipts.reconcileOwnership(resolvedStateRoot, descriptor)
    },

    ownsPendingOwnership(descriptor) {
      /* Joining this instance's retained lane is different from admitting a
         replacement for an unknown owner from an earlier instance. */
      try {
        const expected = lifetimeReceipts.descriptor(descriptor)
        const current = lifetimeReceipts.descriptor(inFlight?.owned?.descriptor)
        return current.id === expected.id && current.publicKey === expected.publicKey
      } catch { return false }
    },

    /* WHAT relayMachineIsEnrolled() ASKS. Synchronous on purpose: the relay
       supervisor's start() takes a predicate, not a promise, and a predicate
       that spawned PowerShell would make every start() a process launch. This
       is the cached answer of the last status() or poll() that actually got
       one. See lastKnownConnected. */
    enrolled() {
      return lastKnownConnected === true
    },

    /* Is a claim in flight? A boolean, so nothing about the token itself has to
       be exposed to answer it. */
    claimOpen() {
      return pending !== null
    },
  }
  /* Only our own bounded replies are decorated; no child object is spread.
     Shared status callers retain the same promise. Measure ownership at
     settlement so a pre-mutation observation cannot authorize a later step. */
  const publicPromises = new WeakMap()
  const withChildState = value => Object.freeze({ ...value, childQuiescent: inFlight === null })
  for (const name of ['status', 'begin', 'poll', 'cancel', 'disconnect', 'administer']) {
    const method = api[name]
    api[name] = (...args) => {
      const answer = method(...args)
      if (!answer || typeof answer.then !== 'function') return withChildState(answer)
      if (!publicPromises.has(answer)) publicPromises.set(answer, answer.then(withChildState))
      return publicPromises.get(answer)
    }
  }
  return api
}

module.exports = {
  CLAIM_ENTRY,
  CODES,
  CODE_VALUES,
  KILL_ESCALATION_MS,
  MAX_NAME_LENGTH,
  MAX_STDOUT_BYTES,
  NETWORK_TIMEOUT_MS,
  REASONS,
  STATUS_TIMEOUT_MS,
  createDeviceClaim,
}
