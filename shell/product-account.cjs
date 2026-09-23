'use strict'

const { performance } = require('node:perf_hooks')

/* THE PRODUCT ACCOUNT: who is using this installation.
 *
 * WHAT THIS IS. An account for this product, held entirely on this computer. A
 * person creates one, signs in, and stays signed in across relaunches until
 * they sign out or the session expires. Its whole job is to turn "a session
 * started on this device" into "this person started it", which is the sentence
 * shell/spawn-record.cjs could not previously write.
 *
 * TWO WAYS TO SIGN IN, AND THE DIFFERENCE BETWEEN THEM.
 *
 *   SIGN IN WITH GOOGLE is the first option and the stronger one. The person's
 *   Google account, verified by Google, becomes this product's identity: the
 *   account's name IS the verified email address. See shell/google-signin.cjs.
 *   No password reaches this program on that path -- it is typed into the
 *   system browser -- and no password is stored for it, because there is none.
 *   The record here holds the Google subject identifier and the address, and
 *   nothing else: NO access token, NO refresh token, no Google credential of
 *   any kind. Once Google has said who somebody is, this file mints its own
 *   session, with its own expiry and its own revocation, exactly as it does for
 *   a local account.
 *
 *   AN ACCOUNT ON THIS COMPUTER is kept, deliberately, as the second option. It
 *   works with no network, it works for somebody who will not sign in with
 *   Google, and it works on a copy that has never been given a Google
 *   application id. Deleting working code because a better option now exists
 *   would leave those people with nothing.
 *
 * WHAT NEITHER OF THEM IS, and the distinction is a terms condition and not a
 * stylistic one: neither is a login to the user's Anthropic or OpenAI account,
 * and neither may be presented as one or accept those credentials.
 * docs/design/SHIPMENT-PLAN.md blocker B14 records that taking a PROVIDER
 * SUBSCRIPTION login inside a third-party product -- signing in to somebody's
 * paid Claude or ChatGPT plan so this product can spend it -- is barred by those
 * providers' terms, and src/lib/setup/provider-auth.js in the engine already
 * refuses to build that form. Google sign-in here is a different thing and B14
 * does not reach it: it is the identity flow Google publishes for exactly this
 * purpose, it asks for `openid email profile` and nothing else, and those grant
 * this product no access to anybody's Drive, Gmail or Calendar. It answers who
 * you are. It does not carry a subscription and cannot spend one.
 *
 * Provider credentials stay in the provider CLIs, where the provider put them.
 * This file never reads them, never stores them, and never asks for them.
 *
 * HOSTED ACCOUNTS. The main-process hosted client can also supply an identity
 * verified by the account service. It owns the remote credential and requires
 * server validation before restoration. This store owns only the local data
 * partition. Hosted records use a separate file so an older release can still
 * read the existing local and Google accounts during a rollback.
 *
 * WHAT IT DOES NOT PROVE. The verifier lives on the same computer as the person
 * typing the password, so anyone who is already this Windows user can delete the
 * account file and make a new account. This is an ATTRIBUTION record among the
 * people who share a machine and a deliberate, revocable gate on the product's
 * own surfaces -- it is not an attestation to a remote party, and nothing here
 * may be described as if it were. shell/spawn-record.cjs states the same limit
 * about its own ledger, for the same reason.
 *
 * HOW THE SECRET IS HELD. The password is never stored, never logged, and never
 * leaves the main process. Only a scrypt verifier is written, with a per-account
 * 16-byte random salt, at the parameters OWASP names first for scrypt
 * (N=2^17, r=8, p=1). Verification is constant-time. A sign-in attempt against a
 * username that does not exist still performs the full derivation, so the reply
 * time does not disclose which usernames are real.
 *
 * HOW THE SESSION IS HELD. There is no bearer token, because there is nothing to
 * bear it to: the authoritative session lives in this process's memory and the
 * renderer only ever asks who it is. What persists across relaunch is one
 * record, encrypted by the OS keystore (Electron safeStorage -> DPAPI), so it is
 * bound to this Windows user and is not readable as plain bytes on disk. It
 * carries an absolute expiry and an epoch. Signing out deletes it; signing out
 * everywhere, or changing a password, advances the account's epoch so that any
 * copy of the file taken beforehand is refused rather than replayed.
 *
 * FAIL CLOSED, EVERYWHERE. Absent, unreadable, corrupt, expired, superseded, or
 * pointing at an account that no longer exists all resolve to SIGNED OUT. There
 * is no branch in this file on which an unreadable byte produces a signed-in
 * user. That is the specific mutant this module is tested against.
 *
 * Every dependency is injected so this is testable without Electron.
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const ACCOUNTS_FILE = 'product-accounts.json'
const HOSTED_ACCOUNTS_FILE = 'hosted-product-accounts.json'
const SESSION_FILE = 'product-session.enc'
const STORE_VERSION = 1

/* WHOSE DATA IS IT. The account partition, and where the line is drawn.
 *
 * Before this, every byte the product kept was PER DEVICE. renderer-prefs.json
 * held one set of settings, the spawn ledger held one list of sessions, and a
 * second person signing in on the same computer inherited the first person's
 * theme, first-run answers and write fences. `accountId` appeared nowhere in
 * the application outside this file, so "sign in" changed a name on a record
 * and nothing else. This is the first thing that actually follows the account.
 *
 * WHAT IS PER ACCOUNT, AND WHAT IS DELIBERATELY NOT:
 *
 *   PER ACCOUNT, and now stored here, one file per account id:
 *     - settings (theme, first-run profile, write fences, panel choices --
 *       everything the renderer persists through localStorage). These are
 *       preferences OF A PERSON.
 *     - the payment method binding: which vault record is this person's card.
 *       A card belongs to a person, not to a computer.
 *
 *   PER DEVICE, and deliberately left alone:
 *     - shell-state.json (window bounds, chosen port, first-paint theme). It
 *       must be readable BEFORE anyone signs in, because it decides what the
 *       window looks like while the sign-in screen is being painted. An
 *       account-scoped window position is a window that cannot be positioned.
 *     - the vault itself. It is DPAPI-sealed to the Windows user; a second
 *       product account on the same Windows login gains nothing from a second
 *       vault, and would lose the OS protection by inventing its own.
 *     - agent-spawn-records.jsonl. This one is the interesting refusal: it is a
 *       hash-chained, signed, append-only ledger. Splitting it per account
 *       would mean one account could delete its own history, and deleting any
 *       account's file would break the chain for everyone else. It stays ONE
 *       ledger, per device, and carries the account in each record's principal
 *       -- so the ATTRIBUTION is per account and the STORAGE is not. A view
 *       filters; it does not partition.
 *
 * SIGNED OUT IS NOT AN ACCOUNT. Every read and every write below refuses when
 * nobody is signed in. There is no "default" partition that a signed-out window
 * writes into, because the next person to sign in would inherit it. */
const ACCOUNT_DATA_DIRECTORY = 'accounts'
const DATA_VERSION = 1
/* The device-level settings file this store ADOPTS from on first sign-in. It is
   read, never written, by this file -- shell/renderer-prefs.cjs remains its only
   writer, and the device copy is left exactly as it was. */
const DEVICE_PREFS_FILE = 'renderer-prefs.json'

/* Bounds mirror shell/renderer-prefs.cjs, because this holds the same values.
   A partition that accepted more than the store it adopts from would be a way
   to get an oversized value past that store's limits. */
const MAX_SETTING_KEYS = 512
const MAX_SETTING_KEY_LENGTH = 256
const MAX_SETTING_VALUE_LENGTH = 64 * 1024
const MAX_DATA_BYTES = 2 * 1024 * 1024

/* The vault keys a payment method may name. An allowlist rather than a pattern:
   this value is written from a renderer call, and the set of records that may
   be called "this person's card" is small, known, and not something a page gets
   to widen. `owner_legal_identity_v1` is deliberately absent -- an identity
   document is not a payment method and must never be attached as one. */
const PAYMENT_VAULT_KEYS = Object.freeze(['payment_card_default'])

/* OWASP Password Storage Cheat Sheet's first-listed scrypt configuration
   (N=2^17, r=8, p=1). Memory is 128*N*r = 134 MB, which is the point: it is
   what makes a stolen verifier expensive to attack offline. `maxmem` must be
   raised explicitly because Node's default cap is 32 MB and scrypt throws
   rather than quietly weakening itself.

   These are exported and asserted by the test suite. Weakening them is a
   security change, so it must fail a test rather than pass review as a tuning
   tweak. */
const SCRYPT_PARAMETERS = Object.freeze({ N: 131072, r: 8, p: 1, keyLength: 64 })
const SCRYPT_MAXMEM = 320 * 1024 * 1024
const SALT_BYTES = 16
const VERIFIER_SCHEME = 'scrypt'

const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000

const MIN_PASSWORD_LENGTH = 12
/* Bounded because the password is an untrusted input to a deliberately
   expensive function. Without a ceiling, a long string is a local denial of
   service against the process that must hash it. */
const MAX_PASSWORD_LENGTH = 200
const MIN_USERNAME_LENGTH = 3
const MAX_USERNAME_LENGTH = 64
const MAX_DISPLAY_NAME_LENGTH = 64
const MAX_ACCOUNTS = 16
const MAX_STORE_BYTES = 256 * 1024

/* scrypt already costs about a second, which is itself a rate limit. The
   lockout exists for the case that cost does not cover: an unattended machine
   and someone with time. It is per-account and it is recorded, so it cannot be
   cleared by closing the window. */
const MAX_FAILED_ATTEMPTS = 5
const LOCKOUT_MS = 15 * 60 * 1000

/* The principal written to the spawn ledger when nobody is signed in.
 *
 * It is a stated word rather than `null` ON PURPOSE. Before an account system
 * existed, `null` meant "this product cannot know who this was". It now would
 * mean either that or "somebody chose not to sign in", and a record whose one
 * identity field is ambiguous between a capability gap and a user action is
 * worse than one that says which. */
const UNAUTHENTICATED_PRINCIPAL = 'unauthenticated'
const PRINCIPAL_PREFIX = 'account:'

/* ---- accounts that Google identified ----
 *
 * THE STORED RECORD IS AN ASSERTION, NOT A CREDENTIAL. `subject` is Google's
 * permanent identifier for the account (it never changes and is never reused);
 * `email` is the address Google says it verified, and it is what the person
 * sees. There is no token field here and there must never be one -- this
 * product does not call a Google API on anybody's behalf, so a stored Google
 * token would be a durable credential to somebody's mail kept on this disk in
 * exchange for nothing.
 *
 * THE ACCOUNT IS KEYED ON `subject`, NOT ON THE ADDRESS. A person can change
 * the address on their Google account; matching on the address would hand their
 * history to whoever the address was reassigned to, and would lose it for them
 * the day they changed it. */
const GOOGLE_PROVIDER = 'google'
const HOSTED_PROVIDER = 'hosted'
/* Stamped by shell/google-oidc.cjs ONLY after a signature, an issuer, an
   audience, an expiry and a nonce have all been checked. This file refuses an
   identity that does not carry it, so a caller that assembles one by hand --
   from an id_token nobody verified, say -- fails closed instead of signing
   somebody in. It is a seatbelt against a future edit, not a cryptographic
   check: the real check is in google-oidc.cjs and this is the reminder that it
   has to have happened. */
const REQUIRED_IDENTITY_ASSURANCE = 'id_token-verified'
const MAX_IDENTITY_SUBJECT_LENGTH = 255
const MAX_IDENTITY_EMAIL_LENGTH = 320

/* The one signed-out answer, built once.
 *
 * Every refusal path in `current()` returns THIS rather than composing its own
 * object. Hand-written duplicates drift: one of six would eventually be written
 * with `signedIn: false` and no `principal`, and the spawn record would then
 * take `undefined` as the identity of whoever started an agent. */
const SIGNED_OUT_STATE = Object.freeze({
  signedIn: false,
  principal: UNAUTHENTICATED_PRINCIPAL,
  account: null,
})

/* Rejected outright, and NOT presented as a strength meter. NIST SP 800-63B
   discourages composition rules and encourages screening against known-common
   secrets; this is a deliberately short list of the passwords that a local
   attacker guesses first, not a breach corpus, and the UI says so rather than
   implying screening it does not do. */
const REFUSED_PASSWORDS = Object.freeze([
  '123456789012', '111111111111', '000000000000', '123456123456',
  'password1234', 'passwordpassword', 'qwertyqwerty', 'qwerty123456',
  'letmein12345', 'iloveyou1234', 'adminadmin12', 'welcome12345',
  /* The product's own on-screen name is here because people reach for it, and
     it is exactly MIN_PASSWORD_LENGTH characters, so length alone will not
     refuse it. The product and the COMPANY are now the same word, so this one
     entry covers both -- it used to be 'missioncontrol', and the company name
     had to be left out because tools/test/chat-agent-bridge-gated.test.mjs
     forbade it anywhere under src/ or shell/. That clause was written when
     "ToolsEnabled" was only an internal tree name; it is the shipped product
     name now, and the gate has been narrowed to the internal-path forms it was
     always aiming at. */
  'toolsenabled', 'abcdefghijkl', 'aaaaaaaaaaaa',
])

class AccountError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'AccountError'
    this.code = code
  }
}

function refusal(code, reason) {
  return Object.freeze({ ok: false, code, reason })
}

function scryptDerive(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      Buffer.from(password, 'utf8'),
      salt,
      SCRYPT_PARAMETERS.keyLength,
      { N: SCRYPT_PARAMETERS.N, r: SCRYPT_PARAMETERS.r, p: SCRYPT_PARAMETERS.p, maxmem: SCRYPT_MAXMEM },
      (error, derived) => { if (error) reject(error); else resolve(derived) },
    )
  })
}

/* The stored form carries its own parameters. A verifier that only recorded the
   digest could never be re-read after the cost is raised, which is how a product
   ends up unable to strengthen its hashing without locking everyone out. */
function encodeVerifier(salt, derived) {
  return [
    VERIFIER_SCHEME,
    `N=${SCRYPT_PARAMETERS.N},r=${SCRYPT_PARAMETERS.r},p=${SCRYPT_PARAMETERS.p}`,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$')
}

function decodeVerifier(value) {
  if (typeof value !== 'string') return null
  const parts = value.split('$')
  if (parts.length !== 4 || parts[0] !== VERIFIER_SCHEME) return null
  const parameters = {}
  for (const pair of parts[1].split(',')) {
    const [key, raw] = pair.split('=')
    const number = Number(raw)
    if (!Number.isSafeInteger(number) || number < 1) return null
    parameters[key] = number
  }
  if (!parameters.N || !parameters.r || !parameters.p) return null
  let salt
  let digest
  try {
    salt = Buffer.from(parts[2], 'base64')
    digest = Buffer.from(parts[3], 'base64')
  } catch { return null }
  if (salt.length < 8 || digest.length < 16) return null
  return { parameters, salt, digest }
}

async function verifyPassword(password, stored) {
  const decoded = decodeVerifier(stored)
  if (!decoded) return false
  let derived
  try {
    derived = await new Promise((resolve, reject) => {
      crypto.scrypt(
        Buffer.from(password, 'utf8'),
        decoded.salt,
        decoded.digest.length,
        { N: decoded.parameters.N, r: decoded.parameters.r, p: decoded.parameters.p, maxmem: SCRYPT_MAXMEM },
        (error, value) => { if (error) reject(error); else resolve(value) },
      )
    })
  } catch { return false }
  if (derived.length !== decoded.digest.length) return false
  return crypto.timingSafeEqual(derived, decoded.digest)
}

/* Spends the same work on a username that does not exist as on one that does.
   Without it, "no such account" returns in microseconds and "wrong password"
   returns in about a second, which enumerates the account list to anyone with a
   stopwatch. */
async function burnEquivalentWork() {
  try {
    await scryptDerive('\u0000decoy', crypto.randomBytes(SALT_BYTES))
  } catch { /* the decoy's only job is to spend time */ }
}

function writeFileDurable(filePath, contents, mode = 0o600) {
  /* Written to a sibling and renamed, so a crash mid-write leaves the previous
     file intact rather than a truncated one. A half-written account store reads
     as corrupt, and corrupt is refused -- which would lock a person out of
     their own product because the power went out. */
  const temporary = `${filePath}.tmp-${crypto.randomBytes(6).toString('hex')}`
  try {
    const handle = fs.openSync(temporary, 'w', mode)
    try {
      fs.writeFileSync(handle, contents)
      fs.fsyncSync(handle)
    } finally {
      fs.closeSync(handle)
    }
    fs.renameSync(temporary, filePath)
  } catch (error) {
    /* A failed write or rename must not strand the complete replacement next
       to the authoritative file. Besides accumulating on repeated failures,
       that sibling can contain account metadata the caller was told was not
       saved. Preserve the original error; cleanup is best effort. */
    try { fs.rmSync(temporary, { force: true }) } catch { /* preserve error */ }
    throw error
  }
}

function normalizeUsername(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().toLowerCase()
  if (trimmed.length < MIN_USERNAME_LENGTH || trimmed.length > MAX_USERNAME_LENGTH) return null
  /* ASCII only, and deliberately. A username is the thing two people compare to
     decide whether they are looking at the same person; Unicode confusables
     make two different strings look identical on screen, which is an
     impersonation primitive in an attribution record. */
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(trimmed)) return null
  return trimmed
}

/* An email address used AS an account name.
 *
 * Deliberately a separate function from `normalizeUsername` rather than a
 * loosened version of it. Local usernames may not contain `@` and never will,
 * so the two name spaces cannot collide -- a local account can never be created
 * with a name that would shadow somebody's Google identity, and vice versa. The
 * same ASCII-only rule applies for the same confusable reason: this string is
 * the thing two people compare to decide whether they are looking at the same
 * person. */
function normalizeIdentityEmail(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().toLowerCase()
  if (trimmed.length < 3 || trimmed.length > MAX_IDENTITY_EMAIL_LENGTH) return null
  if (!/^[a-z0-9](?:[a-z0-9._%+-]*[a-z0-9])?@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(trimmed)) return null
  return trimmed
}

/* The identity as it is STORED. No assurance stamp is required here, because
   what is on disk was checked when it was written -- requiring it would mean
   writing the word into the file, where anyone could type it. */
function validateStoredIdentity(value) {
  if (!isPlainObject(value)) return null
  if (value.provider === HOSTED_PROVIDER) {
    const email = normalizeIdentityEmail(value.email)
    if (!email || typeof value.subject !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.subject)) return null
    return { provider: HOSTED_PROVIDER, subject: value.subject, email }
  }
  if (value.provider !== GOOGLE_PROVIDER) return null
  if (typeof value.subject !== 'string' || !/^[A-Za-z0-9_.-]{1,255}$/.test(value.subject)) return null
  if (value.subject.length > MAX_IDENTITY_SUBJECT_LENGTH) return null
  const email = normalizeIdentityEmail(value.email)
  if (!email) return null
  /* An unverified address is not an identity. It cannot get into the file
     through the sign-in path, and if it is in the file anyway the file is
     wrong -- so this refuses rather than repairs. */
  if (value.emailVerified !== true) return null
  return { provider: GOOGLE_PROVIDER, subject: value.subject, email, emailVerified: true }
}

/* The identity as it ARRIVES from a sign-in. This one demands the assurance
   stamp, and it is the only door into the store from the outside world. */
function validateVerifiedIdentity(value) {
  if (!isPlainObject(value)) return null
  if (value.provider !== GOOGLE_PROVIDER || value.assurance !== REQUIRED_IDENTITY_ASSURANCE) return null
  return validateStoredIdentity(value)
}

function normalizeDisplayName(value, fallback) {
  if (typeof value !== 'string') return fallback
  /* Control characters, zero-width characters and bidi overrides are stripped
     rather than escaped. This string is shown in the interface and written into
     no markup by this file, but a name carrying a newline reads as two lines,
     and a name carrying U+202E reads right-to-left -- so "josh<RLO>nimda" can be
     displayed as if it said something else. In an attribution record, a name
     that renders as a different name is an impersonation primitive.

     WRITTEN AS ESCAPES, NEVER AS THE CHARACTERS THEMSELVES. An earlier version
     of this line contained the literal characters, which made this file read as
     binary to grep and put an invisible bidi override into the product's own
     source -- the precise trick the check exists to defeat. */
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .trim()
  if (!cleaned) return fallback
  return cleaned.slice(0, MAX_DISPLAY_NAME_LENGTH)
}

function passwordRefusal(password, username) {
  if (typeof password !== 'string' || password.length === 0) {
    return refusal('ACCOUNT_PASSWORD_MISSING', 'Enter a password.')
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return refusal(
      'ACCOUNT_PASSWORD_TOO_SHORT',
      `Use at least ${MIN_PASSWORD_LENGTH} characters. Length is what makes a password hard to guess; mixing in symbols is not required.`,
    )
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return refusal('ACCOUNT_PASSWORD_TOO_LONG', `Use at most ${MAX_PASSWORD_LENGTH} characters.`)
  }
  if (password.trim().length === 0) {
    return refusal('ACCOUNT_PASSWORD_BLANK', 'A password of only spaces is not accepted.')
  }
  const folded = password.toLowerCase()
  if (REFUSED_PASSWORDS.includes(folded)) {
    return refusal('ACCOUNT_PASSWORD_COMMON', 'That is one of the first passwords anyone would try. Choose another.')
  }
  if (username && folded === username.toLowerCase()) {
    return refusal('ACCOUNT_PASSWORD_IS_USERNAME', 'The password cannot be the same as the username.')
  }
  return null
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Create the account store.
 *
 * `safeStorage` is required for SESSION PERSISTENCE only. A build where the OS
 * keystore is unavailable can still create accounts and sign in -- it simply
 * cannot carry the session across a relaunch, and says so, rather than either
 * refusing to work or writing a bearer record in the clear.
 */
function createAccountStore({
  safeStorage,
  hostedAccount = null,
  directory,
  now = () => Date.now(),
  sessionLifetimeMs = SESSION_LIFETIME_MS,
} = {}) {
  if (typeof directory !== 'string' || directory.length === 0) {
    throw new AccountError('ACCOUNT_NO_DIRECTORY', 'An account directory is required')
  }
  if (!Number.isSafeInteger(sessionLifetimeMs) || sessionLifetimeMs < 1) {
    throw new AccountError('ACCOUNT_BAD_LIFETIME', 'The session lifetime must be a positive whole number of milliseconds')
  }

  const accountsPath = path.join(directory, ACCOUNTS_FILE)
  const hostedAccountsPath = path.join(directory, HOSTED_ACCOUNTS_FILE)
  const sessionPath = path.join(directory, SESSION_FILE)

  /* The one piece of authoritative signed-in state. It is in memory, in the
     main process, and it is never assigned from anything the renderer sends. */
  let activeSession = null
  let sessionRestored = false
  let erased = false
  let erasePending = null
  /* Which accounts this process has already offered the one-time device-settings
     adoption to. It is a per-PROCESS latch, not the record of whether the
     adoption happened -- that is the `adopted` field in the account's own
     partition, which is what makes the adoption happen once ever rather than
     once per launch. This only stops a hot read path doing a file read it has
     already done. */
  const adoptionConsidered = new Set()
  const mutations = new Set()
  const erasedRefusal = () => refusal('ACCOUNT_DATA_ERASED', 'Local data removal has started. Restart ToolsEnabled before changing accounts.')
  function requireWritable() {
    if (erased) throw new AccountError('ACCOUNT_DATA_ERASED', 'Local data removal has started.')
  }
  function trackedMutation(action) {
    return (...args) => {
      if (erased) return Promise.resolve(erasedRefusal())
      // Register before starting the asynchronous work. The retained promise
      // includes scrypt and every continuation that could write a local file.
      const pending = Promise.resolve().then(() => erased ? erasedRefusal() : action(...args))
      mutations.add(pending)
      pending.then(() => mutations.delete(pending), () => mutations.delete(pending))
      return pending
    }
  }
  function sealForErase({ timeoutMs = 8000 } = {}) {
    if (erasePending) return erasePending
    erased = true
    activeSession = null
    sessionRestored = true
    const boundedMs = Number.isInteger(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 8000) : 8000
    const deadline = performance.now() + boundedMs
    // Sealing itself neither reads nor creates the profile. A deadline refuses
    // cleanup; it does not discard the still-running password operation.
    erasePending = new Promise(resolve => {
      const timer = setTimeout(() => resolve(Object.freeze({ ok:false, sealed:true,
        localQuiesced:false, code:'ACCOUNT_RESET_QUIESCE_UNCONFIRMED' })), boundedMs)
      Promise.allSettled([...mutations]).then(() => {
        clearTimeout(timer)
        resolve(performance.now() >= deadline
          ? Object.freeze({ ok:false, sealed:true, localQuiesced:false, code:'ACCOUNT_RESET_QUIESCE_UNCONFIRMED' })
          : Object.freeze({ ok:true, sealed:true, localQuiesced:true }))
      })
    })
    return erasePending
  }

  function keystoreAvailable() {
    try {
      return Boolean(safeStorage) && typeof safeStorage.isEncryptionAvailable === 'function'
        && safeStorage.isEncryptionAvailable() === true
    } catch { return false }
  }

  /* ---------------------------- the account file ---------------------------- */

  function emptyStore() {
    return { version: STORE_VERSION, accounts: [] }
  }

  function validateAccount(value) {
    if (!isPlainObject(value)) return null
    if (typeof value.id !== 'string' || !/^[0-9a-f]{32}$/.test(value.id)) return null

    /* EXACTLY ONE WAY IN, PER ACCOUNT. A record with both a password verifier
       and a Google identity would be a record with two doors, and the weaker
       one decides -- somebody who signed in with Google would still be
       reachable by guessing a password nobody told them they had. A record with
       NEITHER cannot be signed in to at all and is equally a corrupt record.
       Both are refused, which condemns the file (see `readStore`) rather than
       silently dropping the account. */
    const identity = validateStoredIdentity(value.identity)
    const verifier = decodeVerifier(value.verifier) ? value.verifier : null
    if (Boolean(identity) === Boolean(verifier)) return null

    /* THE NAME OF A GOOGLE ACCOUNT IS THE VERIFIED ADDRESS. Storing them in two
       fields makes it possible for them to disagree, so the check is that they
       do not: a record whose displayed name is one address and whose verified
       identity is another is exactly the impersonation this replaces the
       username-as-identity defect to prevent. */
    const hosted = identity?.provider === HOSTED_PROVIDER
    const username = hosted ? value.username : identity ? normalizeIdentityEmail(value.username) : normalizeUsername(value.username)
    if (hosted && username !== `hosted:${identity.subject}`) return null
    if (!username) return null
    if (identity && !hosted && username !== identity.email) return null

    if (!Number.isSafeInteger(value.createdAtMs) || value.createdAtMs < 0) return null
    if (!Number.isSafeInteger(value.epoch) || value.epoch < 1) return null
    const failedAttempts = Number.isSafeInteger(value.failedAttempts) && value.failedAttempts >= 0 ? value.failedAttempts : 0
    const lockedUntilMs = Number.isSafeInteger(value.lockedUntilMs) && value.lockedUntilMs >= 0 ? value.lockedUntilMs : 0
    const account = {
      id: value.id,
      username,
      displayName: normalizeDisplayName(value.displayName, username),
      createdAtMs: value.createdAtMs,
      epoch: value.epoch,
      failedAttempts,
      lockedUntilMs,
    }
    /* Only the field this account actually has is written back out, so a
       round-trip through the store cannot invent the other one. */
    if (identity) account.identity = identity
    else account.verifier = verifier
    return account
  }

  /**
   * Read the accounts, or refuse.
   *
   * A file that exists and cannot be understood THROWS. It is never silently
   * replaced with an empty store: doing that would present the first-run
   * "create your account" screen to somebody who already has one, and the first
   * thing they did on it would overwrite the account they could not read.
   */
  function readAccountFile(file, hosted) {
    let raw
    try {
      raw = fs.readFileSync(file)
    } catch (error) {
      if (error && error.code === 'ENOENT') return emptyStore()
      throw new AccountError('ACCOUNT_STORE_UNREADABLE', 'The account file could not be read on this computer.')
    }
    if (raw.length > MAX_STORE_BYTES) {
      throw new AccountError('ACCOUNT_STORE_UNREADABLE', 'The account file is larger than this product will read.')
    }
    let parsed
    try {
      parsed = JSON.parse(raw.toString('utf8'))
    } catch {
      throw new AccountError('ACCOUNT_STORE_CORRUPT', 'The account file on this computer is not readable.')
    }
    if (!isPlainObject(parsed) || parsed.version !== STORE_VERSION || !Array.isArray(parsed.accounts)) {
      throw new AccountError('ACCOUNT_STORE_CORRUPT', 'The account file on this computer is not in a form this version understands.')
    }
    const accounts = []
    for (const entry of parsed.accounts) {
      const account = validateAccount(entry)
      /* One unreadable entry condemns the file. Skipping it would silently drop
         a person's account and let the rest of the product carry on as though
         they had never existed. */
      if (!account || (account.identity?.provider === HOSTED_PROVIDER) !== hosted) throw new AccountError('ACCOUNT_STORE_CORRUPT', 'The account file on this computer contains an entry this version cannot read.')
      if (accounts.some(other => other.username === account.username || other.id === account.id)) {
        throw new AccountError('ACCOUNT_STORE_CORRUPT', 'The account file on this computer lists the same account twice.')
      }
      accounts.push(account)
    }
    return { version: STORE_VERSION, accounts }
  }

  function readStore() {
    const local = readAccountFile(accountsPath, false)
    const hosted = readAccountFile(hostedAccountsPath, true)
    const accounts = [...local.accounts, ...hosted.accounts]
    if (new Set(accounts.map(value => value.id)).size !== accounts.length
        || new Set(accounts.map(value => value.username)).size !== accounts.length) {
      throw new AccountError('ACCOUNT_STORE_CORRUPT', 'The account files on this computer list the same account twice.')
    }
    return { version: STORE_VERSION, accounts }
  }

  /* A DAMAGED ACCOUNT FILE IS SET ASIDE, NEVER REPAIRED OR DELETED (T1520).
   *
   * One file that will not read (a torn write, or an entry from a newer
   * version) took every way to sign in with it, and the only action left on
   * the page was removing all of this program's data. This moves each account
   * file that will not read to a kept name beside it, byte for byte, which
   * leaves the ordinary no-account state: create or sign in works again, and
   * the damaged bytes stay on disk for whoever can read them. A file that
   * reads is never moved; when every file reads, nothing happens. */
  function setAsideDamagedStore() {
    if (erased) return erasedRefusal()
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const kept = []
    for (const [file, hosted] of [[accountsPath, false], [hostedAccountsPath, true]]) {
      try {
        readAccountFile(file, hosted)
        continue
      } catch (error) {
        if (!['ACCOUNT_STORE_CORRUPT', 'ACCOUNT_STORE_UNREADABLE'].includes(error?.code)) throw error
      }
      if (!fs.existsSync(file)) continue
      const keptAs = `${path.basename(file)}.damaged-${stamp}`
      const target = path.join(path.dirname(file), keptAs)
      if (fs.existsSync(target)) return refusal('ACCOUNT_STORE_SET_ASIDE_TAKEN', 'A set-aside copy with that name is already there, so the account file was left where it is. Try again in a moment.')
      try {
        fs.renameSync(file, target)
      } catch {
        return refusal('ACCOUNT_STORE_SET_ASIDE_FAILED', 'The damaged account file could not be moved, so it was left where it is.')
      }
      kept.push(keptAs)
    }
    if (kept.length === 0) return refusal('ACCOUNT_STORE_READABLE', 'Each account file on this computer reads on its own, so it was left where it is.')
    return Object.freeze({ ok: true, keptAs: Object.freeze(kept) })
  }

  function writeStore(store) {
    requireWritable()
    // Every account operation changes one account and therefore one file.
    // Refuse a two-file mutation rather than risk a partially committed edit.
    // A hosted login never rewrites the legacy account file, including fields
    // an older reader understands and this version does not use.
    const changes = []
    for (const [file, hosted] of [[accountsPath, false], [hostedAccountsPath, true]]) {
      const before = readAccountFile(file, hosted)
      const after = { version: STORE_VERSION, accounts: store.accounts.filter(value => (value.identity?.provider === HOSTED_PROVIDER) === hosted) }
      if (JSON.stringify(before) !== JSON.stringify(after)) changes.push([file, after])
    }
    if (changes.length > 1) throw new AccountError('ACCOUNT_STORE_WRITE_FAILED', 'The account change needs more than one file and was not saved.')
    requireWritable()
    fs.mkdirSync(directory, { recursive: true })
    for (const [file, value] of changes) writeFileDurable(file, `${JSON.stringify(value, null, 2)}\n`)
  }

  /* ------------------------------ the session ------------------------------ */

  function clearPersistedSession() {
    if (erased) return
    try {
      fs.rmSync(sessionPath, { force: true })
    } catch { /* a session that cannot be deleted is handled by the epoch check */ }
  }

  function persistSession(session) {
    requireWritable()
    if (!keystoreAvailable()) return false
    try {
      const encrypted = safeStorage.encryptString(JSON.stringify(session))
      requireWritable()
      fs.mkdirSync(directory, { recursive: true })
      writeFileDurable(sessionPath, encrypted)
      return true
    } catch {
      /* An unwritable session file means "you will have to sign in again next
         time", not "you are not signed in now". The in-memory session stands. */
      return false
    }
  }

  function sessionStatus(session, store, { readOnly = false } = {}) {
    if (!isPlainObject(session)) return 'invalid'
    if (typeof session.sessionId !== 'string' || !/^[0-9a-f]{32}$/.test(session.sessionId)) return 'invalid'
    if (typeof session.accountId !== 'string' || !/^[0-9a-f]{32}$/.test(session.accountId)) return 'invalid'
    if (!Number.isSafeInteger(session.issuedAtMs) || session.issuedAtMs < 0) return 'invalid'
    if (!Number.isSafeInteger(session.expiresAtMs) || session.expiresAtMs <= 0) return 'invalid'
    if (!Number.isSafeInteger(session.epoch) || session.epoch < 1) return 'invalid'
    if (now() >= session.expiresAtMs) return 'expired'
    const account = store.accounts.find(entry => entry.id === session.accountId)
    if (!account) return 'invalid'
    /* The epoch is what makes signing out everywhere, and changing a password,
       mean something. A session file copied before either event decrypts fine
       and is still refused here. */
    if (account.epoch !== session.epoch) return 'invalid'
    if (account.identity?.provider === HOSTED_PROVIDER) {
      let observed
      if (readOnly) {
        try { observed = hostedAccount?.observeSession?.() } catch { return 'unavailable' }
        // Unknown storage/observation is not evidence of revoked credentials.
        if (!observed || observed.status === 'unavailable') return 'unavailable'
        if (observed.status === 'unverified' || observed.status === 'expired') return observed.status
        if (['invalid', 'signed-out', 'erased'].includes(observed.status)) return 'invalid'
        if (observed.status !== 'current' || !observed.account) return 'unavailable'
      }
      const verified = readOnly ? observed.account : hostedAccount?.verifiedAccount?.()
      // Normal account actions retain their existing restore and verification.
      if (!verified) return hostedAccount?.hasSession?.() === true ? 'unverified' : 'invalid'
      if (verified.id !== account.identity.subject || verified.email !== account.identity.email) return 'invalid'
    }
    return 'current'
  }

  /**
   * LOAD the session left by the previous run. It does not judge it.
   *
   * This function decrypts and parses; `sessionStatus` decides. The split is
   * deliberate and mutation testing is what forced it: when this function
   * ALSO validated, the validation in `current()` covered for it and the check
   * here could be deleted outright with every test still green. A rule enforced
   * in two places is a rule with no test coverage in either.
   *
   * It still fails closed on its own terms -- every path that cannot produce a
   * candidate returns null, and none of them returns a session.
   */
  function readPersistedSession() {
    if (!keystoreAvailable()) return { session: null, status: 'unavailable' }
    let raw
    try {
      raw = fs.readFileSync(sessionPath)
    } catch (error) {
      return { session: null, status: error?.code === 'ENOENT' ? 'signed-out' : 'unavailable' }
    }
    let session
    try {
      session = JSON.parse(safeStorage.decryptString(raw))
    } catch {
      return { session: null, status: 'invalid' }
    }
    if (!isPlainObject(session)) return { session: null, status: 'invalid' }
    return { status: 'candidate', session: Object.freeze({
      sessionId: session.sessionId,
      accountId: session.accountId,
      issuedAtMs: session.issuedAtMs,
      expiresAtMs: session.expiresAtMs,
      epoch: session.epoch,
    }) }
  }

  function restoreSession() {
    if (sessionRestored) return activeSession
    sessionRestored = true
    activeSession = null
    const restored = readPersistedSession()
    // Normal account actions retain their existing invalid-session cleanup.
    if (restored.status === 'invalid') clearPersistedSession()
    activeSession = restored.session
    return activeSession
  }

  /* --------------------------------- reads --------------------------------- */

  /**
   * What the interface may show before anybody has done anything.
   *
   * Never throws. A screen that cannot render because the account file is
   * damaged is a product that cannot be repaired from its own interface.
   */
  function availability() {
    if (erased) return erasedRefusal()
    let store = null
    let storeError = null
    try {
      store = readStore()
    } catch (error) {
      storeError = error
    }
    if (storeError) {
      return Object.freeze({
        ok: false,
        code: storeError.code || 'ACCOUNT_STORE_CORRUPT',
        reason: storeError.message,
        accountCount: 0,
        canPersistSession: keystoreAvailable(),
      })
    }
    return Object.freeze({
      ok: true,
      code: 'ACCOUNT_READY',
      accountCount: store.accounts.length,
      /* False means sign-in works but will not survive a relaunch. The screen
         states that where the person can see it, instead of surprising them
         with a sign-in prompt they thought they had already answered. */
      canPersistSession: keystoreAvailable(),
      sessionLifetimeMs,
      minimumPasswordLength: MIN_PASSWORD_LENGTH,
    })
  }

  /**
   * Who is signed in. The single read the rest of the shell uses.
   *
   * Synchronous, because shell/main.cjs must answer it inside the spawn path,
   * and NEVER carries a secret: there is no token, no verifier and no password
   * in the returned object, so it is safe to log and safe to send to the page.
   */
  function current() {
    if (erased) return SIGNED_OUT_STATE
    const session = restoreSession()
    if (!session) return SIGNED_OUT_STATE

    /* ONE AUTHORITY, RE-ASKED ON EVERY READ.
     *
     * `sessionStatus` is the only thing in this file that decides whether a
     * session is good, and it is asked again here rather than trusted from
     * restore time. Both halves of that matter, and mutation testing is what
     * proved it:
     *
     * An earlier version checked expiry, epoch and existence AGAIN here, in
     * line, duplicating `sessionStatus`. Every one of those duplicated checks
     * was individually deletable with the tests still green, because whichever
     * copy was left standing covered for the other. Three mutants survived that
     * way. Duplicated validation does not double the safety; it halves the
     * evidence that either copy works.
     *
     * And it is RE-ASKED rather than cached because a window left open past its
     * expiry, or open while another window signs out everywhere, must stop
     * being signed in without anything happening to trigger a re-read. */
    let store
    try {
      store = readStore()
    } catch {
      activeSession = null
      return SIGNED_OUT_STATE
    }
    const status = sessionStatus(session, store)
    if (status !== 'current') {
      if (status === 'invalid' || status === 'expired') {
        activeSession = null
        clearPersistedSession()
      }
      return SIGNED_OUT_STATE
    }
    const account = store.accounts.find(entry => entry.id === session.accountId)
    /* THE OTHER WAY A LAUNCH ARRIVES SIGNED IN, and the one the owner's
       installation is actually in: the session was issued days ago and this
       launch RESTORED it, so nothing goes through issueSession() and the
       adoption below would wait for an expiry. Once per process, and only the
       first time a session is confirmed current for this account, so it costs
       one partition read per launch and nothing after: the function itself
       returns immediately for an account that already carries an `adopted`
       record, which every account does after its first pass. */
    if (!adoptionConsidered.has(account.id)) {
      adoptionConsidered.add(account.id)
      try { adoptDeviceSettingsOnceForSoleAccount(account.id) } catch { /* a read of who is signed in must never fail because of an adoption */ }
    }
    return Object.freeze({
      signedIn: true,
      principal: `${PRINCIPAL_PREFIX}${account.id}`,
      account: Object.freeze({
        id: account.id,
        username: account.identity?.provider === HOSTED_PROVIDER ? account.identity.email : account.username,
        displayName: account.displayName,
        createdAtMs: account.createdAtMs,
        /* WHICH DOOR THIS ACCOUNT USES. The screen has to know, because the
           things it may offer differ: there is no password to change on a
           Google account, and there is no "sign in with Google" for a local
           one. Derived from the record rather than remembered from the sign-in,
           so it cannot drift. */
        signInMethod: account.identity ? account.identity.provider : 'local',
        /* Present only on a Google account, and it is the SAME string as the
           username -- carried separately so a surface can say "verified by
           Google" about it without inferring that from the shape of a name. */
        email: account.identity ? account.identity.email : null,
      }),
      session: Object.freeze({
        /* MAIN-PROCESS CONSUMERS ONLY. A decision record that wants to say
           which sign-in approved something reads it here. It is projected OUT
           by the IPC boundary in shell/main.cjs rather than reaching the page:
           nothing accepts it as proof of anything, so it is not a bearer
           token, but a page has no use for it and the smallest surface that
           works is the one to expose. */
        id: session.sessionId,
        issuedAtMs: session.issuedAtMs,
        expiresAtMs: session.expiresAtMs,
      }),
    })
  }

  /**
   * The same answer, minus everything a page has no use for.
   *
   * The renderer boundary sends THIS, never `current()`. Two shapes rather than
   * one because the alternative -- remembering to delete a field at the IPC
   * handler -- is a rule that holds until somebody adds a field, and the field
   * they add will be the one that should not have crossed.
   */
  function currentForRenderer() {
    const state = current()
    if (!state.signedIn) return state
    return Object.freeze({
      signedIn: true,
      principal: state.principal,
      account: state.account,
      session: Object.freeze({ issuedAtMs: state.session.issuedAtMs, expiresAtMs: state.session.expiresAtMs }),
    })
  }

  /**
   * The value shell/spawn-record.cjs writes.
   *
   * A bounded string, always -- either this installation's account id or the
   * stated `unauthenticated`. It is read HERE, in the main process, and is
   * never accepted from the renderer, because an identity a page can choose is
   * not an identity.
   */
  function principal() {
    return current().principal
  }

  /**
   * The current identity for read-only queries. Decode a cold session without
   * adopting it into the cache, then ask the same verifier as current().
   * Never repair/remove a session or adopt preferences on this path.
   */
  function observePrincipal() {
    const observation = (status, principal = null) => Object.freeze({
      ok: status === 'current' || status === 'signed-out',
      status,
      signedIn: status === 'current',
      principal,
    })
    if (erased) return observation('erased')
    const candidate = sessionRestored
      ? { session: activeSession, status: 'signed-out' }
      : readPersistedSession()
    if (!candidate.session) return observation(candidate.status,
      candidate.status === 'signed-out' ? UNAUTHENTICATED_PRINCIPAL : null)
    let store
    try { store = readStore() } catch { return observation('unavailable') }
    const status = sessionStatus(candidate.session, store, { readOnly: true })
    if (status !== 'current') return observation(status)
    return observation('current', `${PRINCIPAL_PREFIX}${candidate.session.accountId}`)
  }

  /* -------------------------------- mutations ------------------------------- */

  async function createAccount({ username, displayName, password } = {}) {
    if (erased) return erasedRefusal()
    const normalized = normalizeUsername(username)
    if (!normalized) {
      return refusal(
        'ACCOUNT_USERNAME_INVALID',
        `Use ${MIN_USERNAME_LENGTH}-${MAX_USERNAME_LENGTH} characters: letters, numbers, and . _ - between them.`,
      )
    }
    const badPassword = passwordRefusal(password, normalized)
    if (badPassword) return badPassword

    let store
    try {
      store = readStore()
    } catch (error) {
      return refusal(error.code || 'ACCOUNT_STORE_CORRUPT', error.message)
    }
    if (store.accounts.length >= MAX_ACCOUNTS) {
      return refusal('ACCOUNT_LIMIT_REACHED', `This computer already holds the maximum of ${MAX_ACCOUNTS} accounts.`)
    }
    if (store.accounts.some(entry => entry.username === normalized)) {
      return refusal('ACCOUNT_USERNAME_TAKEN', 'That name is already used on this computer.')
    }

    const salt = crypto.randomBytes(SALT_BYTES)
    let derived
    try {
      derived = await scryptDerive(password, salt)
    } catch {
      return refusal('ACCOUNT_HASH_FAILED', 'This computer could not protect the password, so no account was created.')
    }

    if (erased) return erasedRefusal()

    const account = {
      id: crypto.randomBytes(16).toString('hex'),
      username: normalized,
      displayName: normalizeDisplayName(displayName, normalized),
      verifier: encodeVerifier(salt, derived),
      createdAtMs: now(),
      epoch: 1,
      failedAttempts: 0,
      lockedUntilMs: 0,
    }
    const isFirstAccountOnThisComputer = store.accounts.length === 0
    try {
      writeStore({ version: STORE_VERSION, accounts: [...store.accounts, account] })
    } catch {
      return refusal('ACCOUNT_STORE_WRITE_FAILED', 'The account could not be saved on this computer.')
    }
    /* AFTER the account exists, and only for the first one. See
       `adoptDeviceSettings`: the settings already on this computer belong to
       whoever has been using it, and at this moment that is the person creating
       the first account. A failure to adopt is not a failure to create -- they
       still have an account, it simply starts empty, which is what would have
       happened anyway before this existed. */
    const adoption = isFirstAccountOnThisComputer
      ? adoptDeviceSettings(account.id)
      : { adopted: false, count: 0 }
    return Object.freeze({
      ok: true,
      account: Object.freeze({ id: account.id, username: account.username, displayName: account.displayName }),
      /* Said out loud so the screen can tell the person what just became
         theirs, rather than moving their settings silently. */
      adoptedSettings: adoption.adopted,
      adoptedSettingCount: adoption.count,
    })
  }

  /* One message for "no such account" and for "wrong password", because two
     messages tell an attacker which usernames exist. The lockout is reported,
     because withholding it just leaves a person retrying a password that was
     right. */
  const BAD_CREDENTIALS = Object.freeze(
    refusal('ACCOUNT_CREDENTIALS_REJECTED', 'That username and password do not match an account on this computer.'),
  )

  /* THE ONE PLACE A SESSION IS MINTED. Both doors come through here.
   *
   * Factored out when Google sign-in was added, and the factoring is the point:
   * two copies of this would eventually differ in the expiry, or in the epoch,
   * or in whether the in-memory session is marked restored -- and the copy that
   * differed would be the one an auth bug lived in. */
  function issueSession(account, at) {
    requireWritable()
    const session = {
      sessionId: crypto.randomBytes(16).toString('hex'),
      accountId: account.id,
      issuedAtMs: at,
      expiresAtMs: at + sessionLifetimeMs,
      epoch: account.epoch,
    }
    activeSession = Object.freeze({ ...session })
    sessionRestored = true
    /* EVERY DOOR INTO A SESSION PASSES THROUGH HERE, which is the point: the
       adoption rule was written at two of the four creation sites and missed at
       the others, and a rule enforced per-site is a rule that drifts. This takes
       nothing when the account already has an `adopted` record, so the two sites
       that adopt at creation are unaffected. See
       adoptDeviceSettingsOnceForSoleAccount. */
    let adoption = { adopted: false, count: 0 }
    try { adoption = adoptDeviceSettingsOnceForSoleAccount(account.id) } catch { /* a sign-in must not fail because an adoption could not be written */ }
    return { session, persisted: persistSession(session), adoption }
  }

  async function signIn({ username, password } = {}) {
    if (erased) return erasedRefusal()
    const normalized = normalizeUsername(username)
    if (typeof password !== 'string' || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) {
      await burnEquivalentWork()
      return erased ? erasedRefusal() : BAD_CREDENTIALS
    }
    let store
    try {
      store = readStore()
    } catch (error) {
      return refusal(error.code || 'ACCOUNT_STORE_CORRUPT', error.message)
    }
    const account = normalized ? store.accounts.find(entry => entry.username === normalized) : null
    /* A GOOGLE ACCOUNT HAS NO PASSWORD DOOR, and this states it rather than
       relying on the fact that it fails anyway.
       It already could not be reached: `normalizeUsername` refuses `@`, so an
       address never matches here, and even if it did `account.verifier` is
       absent and `verifyPassword` refuses an undecodable verifier. Two accidents
       in a row is not a guarantee -- either could be relaxed by somebody who did
       not know it was load-bearing. The refusal is the SAME one a wrong password
       gets, because telling a stranger "that name exists and uses Google" is
       still telling them the name exists. */
    if (account && account.identity) {
      await burnEquivalentWork()
      return erased ? erasedRefusal() : BAD_CREDENTIALS
    }
    if (!account) {
      await burnEquivalentWork()
      return erased ? erasedRefusal() : BAD_CREDENTIALS
    }
    const at = now()
    if (account.lockedUntilMs > at) {
      return refusal(
        'ACCOUNT_LOCKED',
        `Too many wrong passwords. Try again in ${Math.ceil((account.lockedUntilMs - at) / 60000)} minute(s).`,
      )
    }

    const matched = await verifyPassword(password, account.verifier)
    if (erased) return erasedRefusal()
    if (!matched) {
      const failedAttempts = account.failedAttempts + 1
      const locked = failedAttempts >= MAX_FAILED_ATTEMPTS
      try {
        writeStore({
          version: STORE_VERSION,
          accounts: store.accounts.map(entry => (entry.id === account.id
            ? { ...entry, failedAttempts: locked ? 0 : failedAttempts, lockedUntilMs: locked ? at + LOCKOUT_MS : entry.lockedUntilMs }
            : entry)),
        })
      } catch { /* a failure to record the attempt must not report a successful sign-in */ }
      if (locked) {
        return refusal('ACCOUNT_LOCKED', `Too many wrong passwords. Try again in ${Math.ceil(LOCKOUT_MS / 60000)} minute(s).`)
      }
      return BAD_CREDENTIALS
    }

    if (account.failedAttempts !== 0 || account.lockedUntilMs !== 0) {
      try {
        writeStore({
          version: STORE_VERSION,
          accounts: store.accounts.map(entry => (entry.id === account.id ? { ...entry, failedAttempts: 0, lockedUntilMs: 0 } : entry)),
        })
      } catch { /* the counter is a convenience; a correct password still signs in */ }
    }

    const issued = issueSession(account, at)
    return Object.freeze({
      ok: true,
      /* False means this sign-in is good for this run only. Said here so the
         screen can tell the person, rather than letting them discover it at the
         next launch. */
      persisted: issued.persisted,
      account: Object.freeze({ id: account.id, username: account.username, displayName: account.displayName }),
      expiresAtMs: issued.session.expiresAtMs,
    })
  }

  /**
   * SIGN IN WITH AN IDENTITY GOOGLE HAS ALREADY VERIFIED.
   *
   * This function does NOT talk to Google and must never be given anything that
   * has not been through shell/google-oidc.cjs. What arrives is the result of a
   * checked signature, issuer, audience, expiry and nonce; what this does is
   * decide which account on this computer that identity IS, creating one the
   * first time, and then mint a session exactly as a password sign-in does.
   *
   * NOTHING GOOGLE ISSUED IS WRITTEN DOWN. The id_token, the access token and
   * the authorization code are all out of scope by the time this is called, and
   * none of them is a parameter here. What is stored is the subject identifier
   * and the address.
   *
   * FAIL CLOSED, and the interesting case is the third one: an address that
   * already belongs to a DIFFERENT Google account on this computer is refused
   * rather than adopted. That happens when a Workspace address is deleted and
   * reissued to a new person, and quietly handing them the previous holder's
   * account -- their settings, their history, their attached payment method --
   * because the two strings match is the exact failure keying on `subject`
   * exists to prevent.
   */
  // The hosted client, injected only by main, supplies the identity. This
  // method takes no renderer-selected account id, email, or assurance stamp.
  function signInWithHostedAccount() {
    if (erased) return erasedRefusal()
    const verified = hostedAccount?.verifiedAccount?.()
    const identity = verified && validateStoredIdentity({ provider: HOSTED_PROVIDER, subject: verified.id, email: verified.email })
    if (!identity) return refusal('ACCOUNT_HOSTED_IDENTITY_REFUSED', 'Sign in to your ToolsEnabled account before continuing.')
    let store
    try { store = readStore() } catch (error) { return refusal(error.code || 'ACCOUNT_STORE_CORRUPT', error.message) }
    let account = store.accounts.find(value => value.identity?.provider === HOSTED_PROVIDER && value.identity.subject === identity.subject)
    const created = !account
    if (created && store.accounts.length >= MAX_ACCOUNTS) return refusal('ACCOUNT_LIMIT_REACHED', 'This computer has reached its account limit.')
    const at = now()
    if (!account) account = { id: crypto.randomBytes(16).toString('hex'), username: `hosted:${identity.subject}`, displayName: identity.email, identity, createdAtMs: at, epoch: 1, failedAttempts: 0, lockedUntilMs: 0 }
    else account = { ...account, identity }
    try { writeStore({ version: STORE_VERSION, accounts: created ? [...store.accounts, account] : store.accounts.map(value => value.id === account.id ? account : value) }) }
    catch { return refusal('ACCOUNT_STORE_WRITE_FAILED', 'The account could not be saved on this computer.') }
    // Existing Google/local account data never moves merely because an email
    // matches. Hosted subject ids own distinct local data partitions.
    const issued = issueSession(account, at)
    /* SAID OUT LOUD, LIKE THE OTHER TWO CREATION PATHS. This one never called
       `adoptDeviceSettings` and never reported an adoption, so on an
       installation whose only account arrived through this door the settings
       already on the computer were owned by nobody -- see
       adoptDeviceSettingsOnceForSoleAccount, which is where the adoption now
       happens for every door at once. The two fields are here so a screen can
       tell the person what just became theirs rather than moving their settings
       silently, which is the reason the sibling paths carry them. */
    return Object.freeze({ ok: true, created, persisted: issued.persisted && hostedAccount.sessionPersisted?.() === true, adoptedSettings: issued.adoption.adopted, adoptedSettingCount: issued.adoption.count, account: Object.freeze({ id: account.id, username: identity.email, displayName: account.displayName }), expiresAtMs: issued.session.expiresAtMs })
  }

  function hasGoogleProfiles() {
    if (erased) return false
    try { return readStore().accounts.some(entry => entry.identity?.provider === GOOGLE_PROVIDER) }
    catch { return false }
  }

  async function signInWithGoogle({ identity, existingOnly = false } = {}) {
    if (erased) return erasedRefusal()
    const verified = validateVerifiedIdentity(identity)
    if (!verified) {
      return refusal(
        'ACCOUNT_GOOGLE_IDENTITY_REFUSED',
        'The reply from Google was not one this program had checked, so nobody was signed in.',
      )
    }
    let store
    try {
      store = readStore()
    } catch (error) {
      return refusal(error.code || 'ACCOUNT_STORE_CORRUPT', error.message)
    }

    const at = now()
    const bySubject = store.accounts.find(entry => entry.identity?.provider === GOOGLE_PROVIDER && entry.identity.subject === verified.subject)
    const byName = store.accounts.find(entry => entry.username === verified.email)

    if (bySubject) {
      /* THE ADDRESS ON A GOOGLE ACCOUNT CAN CHANGE, and when it does this
         follows it -- the account, its settings and its history stay with the
         person, because they are keyed on the subject and not on the string. */
      const renamed = bySubject.username !== verified.email
      if (renamed && byName && byName.id !== bySubject.id) {
        return refusal(
          'ACCOUNT_GOOGLE_EMAIL_TAKEN',
          'Another account on this computer already uses that email address, so this sign-in was refused rather than merged.',
        )
      }
      if (renamed || bySubject.displayName !== verified.email) {
        try {
          writeStore({
            version: STORE_VERSION,
            accounts: store.accounts.map(entry => (entry.id === bySubject.id
              ? {
                ...entry,
                username: verified.email,
                /* A display name the person chose is theirs and is kept.
                   Google's `name` only fills in when they never chose one. */
                displayName: entry.displayName === entry.username ? verified.email : entry.displayName,
                identity: { ...entry.identity, email: verified.email },
              }
              : entry)),
          })
        } catch {
          return refusal('ACCOUNT_STORE_WRITE_FAILED', 'The change to that account could not be saved on this computer, so nobody was signed in.')
        }
      }
      const account = { ...bySubject, username: verified.email }
      const issued = issueSession(account, at)
      return Object.freeze({
        ok: true,
        created: false,
        persisted: issued.persisted,
        account: Object.freeze({ id: account.id, username: account.username, displayName: account.displayName }),
        expiresAtMs: issued.session.expiresAtMs,
      })
    }

    if (existingOnly) {
      return refusal('ACCOUNT_GOOGLE_PROFILE_NOT_FOUND',
        'That Google account has no previous profile on this computer. Use Sign in with Google for your ToolsEnabled account.')
    }

    if (byName) {
      /* Two shapes, one refusal each, and neither of them signs anybody in.
         The local branch cannot be reached today -- `normalizeUsername` forbids
         `@`, so a local name can never equal an address -- and it is written
         anyway, because "unreachable" is a property of today's validator. */
      return refusal(
        byName.identity ? 'ACCOUNT_GOOGLE_SUBJECT_MISMATCH' : 'ACCOUNT_GOOGLE_NAME_TAKEN',
        byName.identity
          ? 'That email address already identifies a different Google account on this computer, so this sign-in was refused. Nothing was changed.'
          : 'An account on this computer already uses that name, so this sign-in was refused. Nothing was changed.',
      )
    }

    if (store.accounts.length >= MAX_ACCOUNTS) {
      return refusal('ACCOUNT_LIMIT_REACHED', `This computer already holds the maximum of ${MAX_ACCOUNTS} accounts.`)
    }

    const account = {
      id: crypto.randomBytes(16).toString('hex'),
      username: verified.email,
      displayName: normalizeDisplayName(identity.displayName, verified.email),
      /* NO `verifier` FIELD. Not an empty one, not a placeholder: the record
         has no password door at all, and `validateAccount` refuses one that has
         both. */
      identity: { provider: GOOGLE_PROVIDER, subject: verified.subject, email: verified.email, emailVerified: true },
      createdAtMs: at,
      epoch: 1,
      failedAttempts: 0,
      lockedUntilMs: 0,
    }
    const isFirstAccountOnThisComputer = store.accounts.length === 0
    try {
      writeStore({ version: STORE_VERSION, accounts: [...store.accounts, account] })
    } catch {
      return refusal('ACCOUNT_STORE_WRITE_FAILED', 'The account could not be saved on this computer, so nobody was signed in.')
    }
    /* Same rule as a locally created account: the first account on a computer
       that has been in use adopts the settings already on it. */
    const adoption = isFirstAccountOnThisComputer ? adoptDeviceSettings(account.id) : { adopted: false, count: 0 }
    const issued = issueSession(account, at)
    return Object.freeze({
      ok: true,
      created: true,
      persisted: issued.persisted,
      adoptedSettings: adoption.adopted,
      adoptedSettingCount: adoption.count,
      account: Object.freeze({ id: account.id, username: account.username, displayName: account.displayName }),
      expiresAtMs: issued.session.expiresAtMs,
    })
  }

  function signOut() {
    if (erased) return erasedRefusal()
    activeSession = null
    sessionRestored = true
    clearPersistedSession()
    return Object.freeze({ ok: true })
  }

  /**
   * End every session for this account, including ones this process did not
   * issue and any copy of the session file taken earlier.
   *
   * Advancing the epoch is what does it. Deleting the file alone would leave a
   * backup of it replayable, which is the difference between tidying up and
   * revoking.
   */
  function signOutEverywhere() {
    if (erased) return erasedRefusal()
    const state = current()
    if (!state.signedIn) {
      signOut()
      return Object.freeze({ ok: true, revoked: false })
    }
    let store
    try {
      store = readStore()
    } catch (error) {
      return refusal(error.code || 'ACCOUNT_STORE_CORRUPT', error.message)
    }
    try {
      writeStore({
        version: STORE_VERSION,
        accounts: store.accounts.map(entry => (entry.id === state.account.id ? { ...entry, epoch: entry.epoch + 1 } : entry)),
      })
    } catch {
      return refusal('ACCOUNT_STORE_WRITE_FAILED', 'The sessions could not be ended on this computer.')
    }
    signOut()
    return Object.freeze({ ok: true, revoked: true })
  }

  /**
   * Change the password, which also ends every existing session.
   *
   * The current password is required even though the person is already signed
   * in: an unattended unlocked window must not be enough to take an account
   * over permanently.
   */
  async function changePassword({ currentPassword, newPassword } = {}) {
    if (erased) return erasedRefusal()
    const state = current()
    if (!state.signedIn) return refusal('ACCOUNT_NOT_SIGNED_IN', 'Sign in before changing the password.')

    let store
    try {
      store = readStore()
    } catch (error) {
      return refusal(error.code || 'ACCOUNT_STORE_CORRUPT', error.message)
    }
    const account = store.accounts.find(entry => entry.id === state.account.id)
    if (!account) return refusal('ACCOUNT_NOT_SIGNED_IN', 'That account no longer exists on this computer.')
    /* SAID PLAINLY, because here the person IS signed in as this account and
       there is nothing to leak by telling them the truth about it. Falling
       through would answer "the current password is not right" about a password
       that does not exist, which sends somebody hunting for a password they
       never set. */
    if (account.identity) {
      return refusal(
        'ACCOUNT_GOOGLE_NO_PASSWORD',
        'This account signs in with Google, so there is no password here to change. Change it in your Google account instead.',
      )
    }

    if (typeof currentPassword !== 'string' || currentPassword.length === 0 || currentPassword.length > MAX_PASSWORD_LENGTH
      || !(await verifyPassword(currentPassword, account.verifier))) {
      if (erased) return erasedRefusal()
      return refusal('ACCOUNT_CREDENTIALS_REJECTED', 'The current password is not right.')
    }
    if (erased) return erasedRefusal()
    const badPassword = passwordRefusal(newPassword, account.username)
    if (badPassword) return badPassword
    if (newPassword === currentPassword) {
      return refusal('ACCOUNT_PASSWORD_UNCHANGED', 'The new password is the same as the current one.')
    }

    const salt = crypto.randomBytes(SALT_BYTES)
    let derived
    try {
      derived = await scryptDerive(newPassword, salt)
    } catch {
      return refusal('ACCOUNT_HASH_FAILED', 'This computer could not protect the new password, so nothing was changed.')
    }
    if (erased) return erasedRefusal()
    try {
      writeStore({
        version: STORE_VERSION,
        accounts: store.accounts.map(entry => (entry.id === account.id
          ? { ...entry, verifier: encodeVerifier(salt, derived), epoch: entry.epoch + 1, failedAttempts: 0, lockedUntilMs: 0 }
          : entry)),
      })
    } catch {
      return refusal('ACCOUNT_STORE_WRITE_FAILED', 'The new password could not be saved on this computer.')
    }
    /* Every session, including this window's, is now on the previous epoch. The
       person signs in again with the password they just chose, which is how
       they find out it took effect. */
    signOut()
    return Object.freeze({ ok: true, signedOut: true })
  }

  /**
   * Change the name this program shows for the signed-in account.
   *
   * WHY THIS EXISTS AT ALL. It did not, and the consequence was a one-way door
   * at the worst possible moment: the first-run walkthrough creates the account
   * with an empty display name, `normalizeDisplayName` falls back to the
   * username, and that username was then the permanent label on every record of
   * that person's work for the life of the account. A person who typed `jp` in
   * their first ninety seconds was `jp` forever. Google accounts had the same
   * door in a different room -- their display name is set to the verified email
   * address, so an approval record read as somebody's full email address rather
   * than as their name.
   *
   * WHAT IT DOES NOT TOUCH, and each omission is load-bearing:
   *   - the `id`. It is the account identity: `spawn-record` writes
   *     `account:<id>` and the history rows on the account screen are counted by
   *     comparing against it, so a rename must not re-attribute a single past
   *     run. src/account-state.js already states this rule; this is the write
   *     path it was written for.
   *   - the `username`. That is the name typed at sign-in, and on a Google
   *     account it is the verified address, which this program has no business
   *     editing.
   *   - the `epoch`. A rename is not a credential change, so it does not end
   *     sessions. Ending them here would sign a person out for correcting a
   *     typo -- and worse, would hide the result, since the point of pressing
   *     the button is to SEE the new name.
   *   - the `identity`. A Google account may be renamed for display and stays
   *     the same verified identity. `signInWithGoogle` already agrees: it
   *     overwrites the display name only when it still equals the username.
   *
   * AN EMPTY NAME IS AN ANSWER, NOT AN ABSENCE, and it is the only reading that
   * lets a person undo a rename. Blank means "go back to being shown as my
   * username", the reply says `clearedToUsername` so the screen can say which of
   * the two happened, and src/account-markup.js prints that rule on the form
   * ABOVE the field rather than leaving it to be discovered. A value that is not
   * a string at all is a different thing -- a malformed call, not a choice --
   * and is refused rather than read as blank.
   *
   * A NAME IS NOT CHECKED FOR UNIQUENESS, deliberately and consistently with
   * `createAccount`, which does not check either. Display names are not
   * identities here; the id is. Adding the check on this path alone would let a
   * person create an account as "josh" but not rename to it, which is two rules
   * where the product has one.
   */
  function changeDisplayName({ displayName } = {}) {
    if (erased) return erasedRefusal()
    const state = current()
    if (!state.signedIn) return refusal('ACCOUNT_NOT_SIGNED_IN', 'Sign in before changing the name shown for an account.')
    /* Not `!displayName`. An empty string is a choice this accepts; anything
       that is not a string is a call this build cannot read, and reading it as
       blank would silently clear somebody's name on a malformed request. */
    if (typeof displayName !== 'string') {
      return refusal('ACCOUNT_DISPLAY_NAME_INVALID', 'No name was sent, so nothing was changed.')
    }
    /* A DEFENSIVE BOUND, not the length rule. The length rule is
       `MAX_DISPLAY_NAME_LENGTH` and the normalizer applies it by truncating, so
       a person who pastes a long name gets a short one rather than a refusal.
       This refuses only input that is not a name at all -- it stops a
       megabyte-long string reaching the character-class replace above. The IPC
       boundary in shell/main.cjs bounds it first; this holds if that is ever
       relaxed, because a validator that relies on its caller is not one. */
    if (displayName.length > MAX_DISPLAY_NAME_LENGTH * 64) {
      return refusal('ACCOUNT_DISPLAY_NAME_INVALID', 'That is longer than a name, so nothing was changed.')
    }

    let store
    try {
      store = readStore()
    } catch (error) {
      return refusal(error.code || 'ACCOUNT_STORE_CORRUPT', error.message)
    }
    const account = store.accounts.find(entry => entry.id === state.account.id)
    if (!account) return refusal('ACCOUNT_NOT_SIGNED_IN', 'That account no longer exists on this computer.')

    /* The SAME normalizer the create path uses, so a name that is acceptable
       when an account is made is acceptable when it is renamed. It strips the
       control, zero-width and bidi characters that would let a rendered name
       claim to be a different name -- see its own comment; that is the whole
       reason a rename cannot simply assign the string. */
    const next = normalizeDisplayName(displayName, account.username)
    if (next === account.displayName) {
      return refusal('ACCOUNT_DISPLAY_NAME_UNCHANGED', 'That is already the name shown for this account, so nothing was changed.')
    }
    try {
      writeStore({
        version: STORE_VERSION,
        accounts: store.accounts.map(entry => (entry.id === account.id ? { ...entry, displayName: next } : entry)),
      })
    } catch {
      return refusal('ACCOUNT_STORE_WRITE_FAILED', 'The new name could not be saved on this computer, so nothing was changed.')
    }
    return Object.freeze({
      ok: true,
      /* Returned so the screen can show what it BECAME rather than what was
         typed. The two differ whenever the normalizer stripped something, and a
         screen echoing the typed string in that case would be telling somebody
         their name is one thing while the record says another. */
      displayName: next,
      clearedToUsername: next === account.username,
    })
  }

  /* ------------------------- the account partition -------------------------
   *
   * One file per account id, under `<userData>/accounts/`. The id is the file
   * name and it is validated 32-hex before it is ever joined to a path, in
   * `validateAccount` on the way in and again in `accountDataPath` below --
   * because a file name taken from a record is a path traversal waiting for the
   * validation in front of it to be relaxed.
   *
   * NOT ENCRYPTED, AND THAT IS THE HONEST CHOICE. These are preferences and one
   * vault KEY NAME. There is no password, no token and no card value here, so
   * encrypting it would buy nothing except the appearance of protection -- and
   * the session file next to it, which does hold something worth sealing, is
   * sealed. The comment at the top of this file states the same limit about the
   * account itself: this is a partition between the people who share a computer,
   * not a defence against the Windows user they all sign in as. */

  const dataDirectory = path.join(directory, ACCOUNT_DATA_DIRECTORY)

  function accountDataPath(accountId) {
    if (typeof accountId !== 'string' || !/^[0-9a-f]{32}$/.test(accountId)) {
      throw new AccountError('ACCOUNT_DATA_BAD_ID', 'An account id is required to read account data')
    }
    return path.join(dataDirectory, `${accountId}.json`)
  }

  function emptyData(accountId) {
    return {
      version: DATA_VERSION,
      accountId,
      settings: {},
      paymentMethod: null,
      adopted: null,
      updatedAtMs: 0,
    }
  }

  function validSettingEntry(key, value) {
    if (typeof key !== 'string' || key.length === 0 || key.length > MAX_SETTING_KEY_LENGTH) return false
    if (typeof value !== 'string' || value.length > MAX_SETTING_VALUE_LENGTH) return false
    return true
  }

  /* A payment method is a REFERENCE. There is no field here that could hold a
     card number, an expiry, a CVC or a token, because the record itself never
     leaves the vault -- this says WHICH vault record is this person's card and
     WHEN it was attached, and nothing else. The store name is carried so the
     screen can tell the truth when the installation's vault is not the vault the
     record was entered into, which is a real state on this machine and reads as
     "no card on file" to anything that only stores a boolean. */
  function validPaymentMethod(value) {
    if (!isPlainObject(value)) return null
    if (!PAYMENT_VAULT_KEYS.includes(value.vaultKey)) return null
    if (!Number.isSafeInteger(value.attachedAtMs) || value.attachedAtMs < 0) return null
    const store = typeof value.vaultStore === 'string' && value.vaultStore.length <= 400 ? value.vaultStore : null
    const note = typeof value.note === 'string' && value.note.length <= 400 ? value.note : null
    return { vaultKey: value.vaultKey, attachedAtMs: value.attachedAtMs, vaultStore: store, note }
  }

  /**
   * Read one account's partition. Never throws, and an unreadable file is NOT
   * an empty one.
   *
   * The distinction is the same one the account file itself makes: silently
   * substituting an empty record for a damaged one presents the person with a
   * blank slate and lets the next write destroy what could not be read.
   */
  function readAccountData(accountId) {
    if (erased) return erasedRefusal()
    let filePath
    try {
      filePath = accountDataPath(accountId)
    } catch (error) {
      return { ok: false, code: error.code, reason: error.message }
    }
    let raw
    try {
      raw = fs.readFileSync(filePath)
    } catch (error) {
      if (error && error.code === 'ENOENT') return { ok: true, data: emptyData(accountId), fresh: true }
      return { ok: false, code: 'ACCOUNT_DATA_UNREADABLE', reason: 'Your settings for this account could not be read on this computer.' }
    }
    if (raw.length > MAX_DATA_BYTES) {
      return { ok: false, code: 'ACCOUNT_DATA_UNREADABLE', reason: 'The settings file for this account is larger than this product will read.' }
    }
    let parsed
    try {
      parsed = JSON.parse(raw.toString('utf8'))
    } catch {
      return { ok: false, code: 'ACCOUNT_DATA_CORRUPT', reason: 'The settings file for this account is not readable.' }
    }
    if (!isPlainObject(parsed) || parsed.version !== DATA_VERSION || parsed.accountId !== accountId) {
      /* `parsed.accountId !== accountId` is the cross-account check, and it is
         not decoration. The file is named by id; if its CONTENTS name a
         different account it is either a copy somebody made or a rename, and
         either way answering with it would show one person another person's
         settings. */
      return { ok: false, code: 'ACCOUNT_DATA_CORRUPT', reason: 'The settings file for this account belongs to a different account or a different version.' }
    }
    const settings = {}
    if (isPlainObject(parsed.settings)) {
      for (const [key, value] of Object.entries(parsed.settings)) {
        if (Object.keys(settings).length >= MAX_SETTING_KEYS) break
        if (validSettingEntry(key, value)) settings[key] = value
      }
    }
    return {
      ok: true,
      data: {
        version: DATA_VERSION,
        accountId,
        settings,
        paymentMethod: validPaymentMethod(parsed.paymentMethod),
        adopted: isPlainObject(parsed.adopted) && Number.isSafeInteger(parsed.adopted.atMs)
          ? { atMs: parsed.adopted.atMs, from: typeof parsed.adopted.from === 'string' ? parsed.adopted.from.slice(0, 200) : null, count: Number.isSafeInteger(parsed.adopted.count) ? parsed.adopted.count : 0 }
          : null,
        updatedAtMs: Number.isSafeInteger(parsed.updatedAtMs) ? parsed.updatedAtMs : 0,
      },
    }
  }

  function writeAccountData(data) {
    requireWritable()
    fs.mkdirSync(dataDirectory, { recursive: true })
    writeFileDurable(accountDataPath(data.accountId), `${JSON.stringify(data, null, 2)}\n`)
  }

  /**
   * THE FIRST ACCOUNT INHERITS THE COMPUTER'S SETTINGS. Every later one starts
   * empty.
   *
   * The person who creates the first account on a computer that has been in use
   * is the person whose theme, first-run answers and write fences are already
   * on it -- they made them, before there was an account to record them under.
   * Throwing that away at the moment they sign in would be the product
   * punishing them for signing in.
   *
   * The SECOND account must not inherit it, and that is the whole reason this
   * runs at creation time and only when the store was empty: at any later
   * moment "the settings on this computer" are somebody else's.
   *
   * The device file is READ, never written and never removed. It stays the
   * signed-out layer, and shell/renderer-prefs.cjs remains its only writer.
   */
  function adoptDeviceSettings(accountId) {
    if (erased) return { adopted:false, count:0 }
    let raw
    try {
      raw = fs.readFileSync(path.join(directory, DEVICE_PREFS_FILE), 'utf8')
    } catch {
      return { adopted: false, count: 0 }
    }
    let parsed
    try { parsed = JSON.parse(raw) } catch { return { adopted: false, count: 0 } }
    if (!isPlainObject(parsed) || !isPlainObject(parsed.values)) return { adopted: false, count: 0 }
    const settings = {}
    for (const [key, value] of Object.entries(parsed.values)) {
      if (Object.keys(settings).length >= MAX_SETTING_KEYS) break
      if (validSettingEntry(key, value)) settings[key] = value
    }
    const count = Object.keys(settings).length
    if (count === 0) return { adopted: false, count: 0 }
    const data = emptyData(accountId)
    data.settings = settings
    data.adopted = { atMs: now(), from: DEVICE_PREFS_FILE, count }
    data.updatedAtMs = now()
    try {
      writeAccountData(data)
    } catch {
      return { adopted: false, count: 0 }
    }
    return { adopted: true, count }
  }

  /**
   * THE SAME RULE, APPLIED LATE, FOR THE ONE ACCOUNT ON THIS COMPUTER.
   *
   * `adoptDeviceSettings` runs at CREATION. Two things get past it, and both
   * were measured, not imagined:
   *
   *  - a creation path that simply did not call it. `signInWithHostedAccount`
   *    creates an account and issues a session with no adoption at all, and on
   *    the owner's own installation that is the only account there is: its
   *    partition holds one key, its `adopted` is null, and seven choices --
   *    `mc.theme` and six `mc.set.*` rows -- sit in `renderer-prefs.json` owned
   *    by nobody. public/durable-storage.js `getItem` answers `null` for an
   *    account-scoped name the overlay has never heard of, so from where the
   *    person sits every one of those choices is simply gone the moment they
   *    are signed in. That is the report this fixes;
   *  - a value written while the store still read signed out, which lands in
   *    the device record and is then unreadable from the account.
   *
   * IT IS THE EXISTING RULE, NOT A NEW ONE. It fires only when this computer
   * has exactly ONE account, which is the same condition `isFirstAccountOnThisComputer`
   * tests, evaluated later. With a second account on the computer "the settings
   * on this computer" are somebody else's and this does nothing at all.
   *
   * WHAT IT WILL NOT DO. It MERGES: a key the account already holds WINS and is
   * never overwritten, because the account partition is the newer decision by
   * construction. `paymentMethod` is carried through untouched -- an adoption
   * that detached somebody's card would be a far worse bug than the one it
   * fixes. And it records `adopted` even when it took nothing, so it runs ONCE:
   * without that, a setting the person deliberately returned to its default
   * would be resurrected from the stale device copy on the next sign-in, and a
   * setting that comes back from the dead is worse than one that resets. That is
   * the same reasoning `drainedOrigins` encodes in shell/renderer-prefs.cjs.
   */
  function adoptDeviceSettingsOnceForSoleAccount(accountId) {
    if (erased) return { adopted: false, count: 0 }
    let store
    try { store = readStore() } catch { return { adopted: false, count: 0 } }
    if (store.accounts.length !== 1 || store.accounts[0].id !== accountId) return { adopted: false, count: 0 }

    const read = readAccountData(accountId)
    /* An unreadable partition is NOT an empty one: merging into a record we
       could not read would write a file that claims to be the person's
       settings and is not. */
    if (!read.ok || read.data.adopted !== null) return { adopted: false, count: 0 }

    let parsed
    try { parsed = JSON.parse(fs.readFileSync(path.join(directory, DEVICE_PREFS_FILE), 'utf8')) }
    catch (error) {
      if (error?.code !== 'ENOENT') return { adopted: false, count: 0 }
      // An absent device record is an empty first sign-in, not a reason to
      // adopt future signed-out choices into this account on a later sign-in.
      parsed = { values: {} }
    }
    if (!isPlainObject(parsed) || !isPlainObject(parsed.values)) return { adopted: false, count: 0 }

    const settings = { ...read.data.settings }
    let count = 0
    for (const [key, value] of Object.entries(parsed.values)) {
      if (Object.keys(settings).length >= MAX_SETTING_KEYS) break
      if (Object.prototype.hasOwnProperty.call(settings, key)) continue
      if (!validSettingEntry(key, value)) continue
      settings[key] = value
      count += 1
    }
    const data = { ...read.data, settings, adopted: { atMs: now(), from: DEVICE_PREFS_FILE, count }, updatedAtMs: now() }
    try { writeAccountData(data) } catch { return { adopted: false, count: 0 } }
    return { adopted: count > 0, count }
  }

  /** The signed-in account's partition, or a refusal naming why. */
  function accountDataForRenderer() {
    const state = current()
    if (!state.signedIn) {
      return Object.freeze({
        ok: false,
        code: 'ACCOUNT_NOT_SIGNED_IN',
        reason: 'Nobody is signed in, so there is no account whose data this would be.',
      })
    }
    const read = readAccountData(state.account.id)
    if (!read.ok) return Object.freeze({ ok: false, code: read.code, reason: read.reason })
    return Object.freeze({
      ok: true,
      accountId: state.account.id,
      settingCount: Object.keys(read.data.settings).length,
      settingKeys: Object.freeze(Object.keys(read.data.settings).sort()),
      paymentMethod: read.data.paymentMethod ? Object.freeze({ ...read.data.paymentMethod }) : null,
      adopted: read.data.adopted ? Object.freeze({ ...read.data.adopted }) : null,
      updatedAtMs: read.data.updatedAtMs,
    })
  }

  /* This is a comparison fence, never an account selector. `current()` supplies
     the only account that may be read or written. Check it before the partition
     operation so a queued renderer write cannot land after its account changed. */
  function expectedAccountMatches(state, request) {
    if (!request || !Object.hasOwn(request, 'expectedAccountId')) return null
    const expectedAccountId = request.expectedAccountId
    if (typeof expectedAccountId !== 'string' || !/^[0-9a-f]{32}$/.test(expectedAccountId)
      || expectedAccountId !== state.account.id) {
      return refusal('ACCOUNT_CHANGED', 'The signed-in account changed before this setting could be read or written.')
    }
    return null
  }

  /** Read one setting for the signed-in account. */
  function getSetting(key, options = {}) {
    const state = current()
    if (!state.signedIn) return Object.freeze({ ok: false, code: 'ACCOUNT_NOT_SIGNED_IN', reason: 'Nobody is signed in.' })
    const fence = expectedAccountMatches(state, options)
    if (fence) return fence
    if (typeof key !== 'string' || key.length === 0 || key.length > MAX_SETTING_KEY_LENGTH) {
      return Object.freeze({ ok: false, code: 'ACCOUNT_DATA_BAD_KEY', reason: 'That is not a settings key.' })
    }
    const read = readAccountData(state.account.id)
    if (!read.ok) return Object.freeze({ ok: false, code: read.code, reason: read.reason })
    const value = Object.prototype.hasOwnProperty.call(read.data.settings, key) ? read.data.settings[key] : null
    return Object.freeze({ ok: true, key, value, accountId: state.account.id })
  }

  /** Write, or with `value: null` remove, one setting for the signed-in account. */
  function putSetting(request = {}) {
    const { key, value } = request
    if (erased) return erasedRefusal()
    const state = current()
    if (!state.signedIn) return refusal('ACCOUNT_NOT_SIGNED_IN', 'Sign in before changing settings that belong to an account.')
    const fence = expectedAccountMatches(state, request)
    if (fence) return fence
    if (typeof key !== 'string' || key.length === 0 || key.length > MAX_SETTING_KEY_LENGTH) {
      return refusal('ACCOUNT_DATA_BAD_KEY', 'That is not a settings key.')
    }
    const removing = value === null || value === undefined
    if (!removing && !validSettingEntry(key, value)) {
      return refusal('ACCOUNT_DATA_BAD_VALUE', `A setting must be text of at most ${MAX_SETTING_VALUE_LENGTH} characters.`)
    }
    const read = readAccountData(state.account.id)
    /* A damaged partition is not overwritten. The person is told; the file that
       could not be read is left for them to keep or discard. */
    if (!read.ok) return refusal(read.code, read.reason)
    const data = read.data
    if (removing) {
      delete data.settings[key]
    } else {
      if (!Object.prototype.hasOwnProperty.call(data.settings, key) && Object.keys(data.settings).length >= MAX_SETTING_KEYS) {
        return refusal('ACCOUNT_DATA_FULL', `An account holds at most ${MAX_SETTING_KEYS} settings.`)
      }
      data.settings[key] = value
    }
    data.updatedAtMs = now()
    try {
      writeAccountData(data)
    } catch {
      return refusal('ACCOUNT_DATA_WRITE_FAILED', 'That setting could not be saved on this computer.')
    }
    return Object.freeze({ ok: true, key, removed: removing })
  }

  /**
   * ATTACH a vault record to this account as its payment method.
   *
   * ATTACHMENT, AND ONLY ATTACHMENT. This writes a KEY NAME. It does not read
   * the vault, does not decrypt anything, does not validate a card, does not
   * contact a payment provider and cannot move money -- there is no code path
   * from here to one. The record it names stays in the vault, sealed, and this
   * file never sees a digit of it.
   */
  function attachPaymentMethod({ vaultKey, vaultStore, note } = {}) {
    if (erased) return erasedRefusal()
    const state = current()
    if (!state.signedIn) return refusal('ACCOUNT_NOT_SIGNED_IN', 'Sign in before attaching a payment method to an account.')
    if (!PAYMENT_VAULT_KEYS.includes(vaultKey)) {
      return refusal('ACCOUNT_PAYMENT_KEY_REFUSED', 'That is not a vault record this product will treat as a payment method.')
    }
    const read = readAccountData(state.account.id)
    if (!read.ok) return refusal(read.code, read.reason)
    const data = read.data
    data.paymentMethod = {
      vaultKey,
      attachedAtMs: now(),
      vaultStore: typeof vaultStore === 'string' && vaultStore.length <= 400 ? vaultStore : null,
      note: typeof note === 'string' && note.length <= 400 ? note : null,
    }
    data.updatedAtMs = now()
    try {
      writeAccountData(data)
    } catch {
      return refusal('ACCOUNT_DATA_WRITE_FAILED', 'The payment method could not be attached on this computer.')
    }
    return Object.freeze({ ok: true, vaultKey, attachedAtMs: data.paymentMethod.attachedAtMs })
  }

  /** Remove the binding. The vault record itself is untouched. */
  function detachPaymentMethod() {
    if (erased) return erasedRefusal()
    const state = current()
    if (!state.signedIn) return refusal('ACCOUNT_NOT_SIGNED_IN', 'Sign in before changing a payment method.')
    const read = readAccountData(state.account.id)
    if (!read.ok) return refusal(read.code, read.reason)
    const data = read.data
    data.paymentMethod = null
    data.updatedAtMs = now()
    try {
      writeAccountData(data)
    } catch {
      return refusal('ACCOUNT_DATA_WRITE_FAILED', 'The payment method could not be removed on this computer.')
    }
    return Object.freeze({ ok: true })
  }

  return Object.freeze({
    availability,
    setAsideDamagedStore,
    current,
    currentForRenderer,
    principal,
    observePrincipal,
    createAccount: trackedMutation(createAccount),
    signIn: trackedMutation(signIn),
    signInWithGoogle: trackedMutation(signInWithGoogle),
    hasGoogleProfiles,
    signInWithHostedAccount,
    signOut,
    signOutEverywhere,
    changePassword: trackedMutation(changePassword),
    changeDisplayName,
    accountsPath,
    sessionPath,
    dataDirectory,
    accountDataPath,
    readAccountData,
    accountDataForRenderer,
    getSetting,
    putSetting,
    attachPaymentMethod,
    detachPaymentMethod,
    sealForErase,
  })
}

/* ONE STORE PER DIRECTORY, FOR THE WHOLE MAIN PROCESS.
 *
 * Two consumers each calling createAccountStore() over the same userData look
 * harmless, because both read the same files. They are not, and the failure is
 * exactly the one an auth bug is made of: the authoritative session lives in
 * MEMORY. When the OS keystore is unavailable, a sign-in is deliberately not
 * written to disk at all, so a second instance built afterwards would answer
 * "signed out" while the first answers "signed in" -- and whichever one the
 * audit record happened to ask would decide whose name went on it.
 *
 * Every main-process consumer must come through here. The first caller decides
 * the directory; later callers naming a different one are refused rather than
 * silently handed the first, because that would be a consumer reading an
 * account file it did not ask for.
 */
let shared = null
function sharedAccountStore(options = {}) {
  if (shared) {
    if (typeof options.directory === 'string' && options.directory !== shared.directory) {
      throw new AccountError(
        'ACCOUNT_STORE_ALREADY_BOUND',
        'The account store is already bound to a different directory in this process',
      )
    }
    return shared.store
  }
  const store = createAccountStore(options)
  shared = { directory: options.directory, store }
  return store
}

/* Tests only. Nothing in the shipped paths calls this: a running app that could
   swap its own account store mid-flight is a running app whose audit principal
   can be swapped mid-flight. */
function resetSharedAccountStoreForTests() {
  shared = null
}

module.exports = {
  createAccountStore,
  sharedAccountStore,
  resetSharedAccountStoreForTests,
  AccountError,
  SCRYPT_PARAMETERS,
  SCRYPT_MAXMEM,
  SESSION_LIFETIME_MS,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
  MIN_USERNAME_LENGTH,
  MAX_USERNAME_LENGTH,
  MAX_ACCOUNTS,
  MAX_FAILED_ATTEMPTS,
  LOCKOUT_MS,
  UNAUTHENTICATED_PRINCIPAL,
  PRINCIPAL_PREFIX,
  GOOGLE_PROVIDER,
  REQUIRED_IDENTITY_ASSURANCE,
  REFUSED_PASSWORDS,
  encodeVerifier,
  decodeVerifier,
  normalizeUsername,
  normalizeIdentityEmail,
  validateVerifiedIdentity,
  /* Exported so the DEFENSIVE branch inside it can be tested directly. In
     normal operation `readStore` refuses a malformed verifier before this is
     ever reached, which means a mutation that made this function ADMIT on an
     unreadable verifier survived the whole suite -- the branch was real, the
     coverage was not. An unreachable fail-open is still a fail-open waiting for
     the guard in front of it to change. */
  verifyPassword,
}
