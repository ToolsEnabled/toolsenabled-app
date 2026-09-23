'use strict'

/* WHERE THE GOOGLE SIGN-IN APPLICATION ID COMES FROM, AND WHAT HAPPENS WHEN
 * THERE ISN'T ONE.
 *
 * A Google OAuth client id identifies THIS APPLICATION to Google. It is public
 * by construction: it travels in a URL the browser opens, so every customer and
 * every proxy sees it. Shipping it inside the artifact is correct and is what
 * Google's Desktop-app client type expects.
 *
 * THE CLIENT SECRET. THIS FILE USED TO REFUSE ONE, AND THAT WAS MEASURED WRONG.
 *
 * The refusal rested on a factual claim -- that Google's Desktop-app client type
 * "issues no usable secret" and that PKCE replaces it. Google's own servers say
 * otherwise. Asked to exchange an authorization code for a Desktop-app client,
 * with a correct PKCE S256 verifier and no secret, Google answers:
 *
 *     HTTP 400  {"error":"invalid_request",
 *                "error_description":"client_secret is missing."}
 *
 * measured against this product's real client on 2026-08-11. Google documents
 * the same thing: the client_secret exemption in "OAuth 2.0 for iOS & Desktop
 * Apps" names Android, iOS and Chrome clients only, and Desktop is not among
 * them. PKCE is required and is not a substitute. A build that refuses to carry
 * a secret therefore cannot complete a single real sign-in -- the refusal did
 * not protect anybody, it just moved the failure to the last step of the flow,
 * where a customer meets it instead of a reviewer.
 *
 * SO WHAT IS THIS "SECRET", REALLY. Google's own answer, for installed apps:
 * "the client secret is obviously not treated as a secret". It is a second
 * public identifier for the application, and it is shipped inside every desktop
 * program that signs in with Google -- gcloud and rclone are the obvious ones.
 * It grants nothing on its own: it names the application, and PKCE proves the
 * exchange comes from the process that started the sign-in.
 *
 * WHAT THAT DOES NOT LICENCE. It is still per-application. A shipped product
 * must carry a client registered FOR IT and for identity scopes only -- never a
 * client that also holds a person's Drive, Gmail or Calendar grants, because
 * publishing that client's identifiers hands every customer the application
 * identity that those grants were issued to. See docs/GOOGLE-SIGN-IN-SETUP.md.
 *
 * It is never printed, never logged, never returned to a renderer, and never put
 * in a refusal message -- only the fact of its presence is reportable.
 *
 * THE ABSENCE CASE IS THE IMPORTANT ONE, and it is the state this machine is in
 * until the owner registers the client. NO CLIENT ID MUST NOT MEAN "sign in
 * anyway", must not mean a hidden button, and must not mean a button that fails
 * with a shrug. It means: the Google option is SHOWN, DISABLED, and says in a
 * sentence what is missing and where it goes -- and the local account, which
 * works today, is offered instead. A person is never left on a screen with
 * nothing that works.
 *
 * THE ABSENCE SENTENCE HAD TO SAY WHERE, AND FOR A LONG TIME IT DID NOT. The
 * owner, on 2026-08-23: "we have the oauth in vault ive done this like 10
 * times". He was right and this file was looking in the wrong place. The
 * product's own credential catalogue (the engine's
 * src/lib/credential-metadata.js) says OAuth client credentials live in the
 * vault; this resolver read two files and an environment variable and never
 * asked the vault at all. So a person who stored the credentials exactly where
 * the product says they go was told, permanently and with no way to find out
 * why, that the feature was unavailable. TEN ATTEMPTS OF THAT WERE BLAMED ON
 * THE PERSON. A refusal that cannot be acted on is how that happens, so every
 * refusal below now names the store and the two record names.
 *
 * WHICH VAULT RECORDS, AND WHY NOT THE OBVIOUS ONES. `google_client_id` and
 * `google_client_secret` are in the vault and are NOT these. They are the
 * capability layer's client -- the engine's src/lib/google-oauth.js -- and they
 * hold the owner's Drive, Gmail and Calendar grants;
 * docs/GOOGLE-SIGN-IN-SETUP.md says in as many words never to reuse that client
 * here ("Never reuse the `google_client_id` in the vault"), and
 * tools/check-asar-manifest.mjs refuses a build whose shipped config carries it.
 *
 * The sign-in client is its own registration, identity scopes only. The names
 * below are not invented here: that same document, in its opening note, already
 * calls the sign-in client's secret `product_google_signin_client_secret` in the
 * vault -- written when the 2026-08-11 live run borrowed that client -- and the
 * id is that name's other half. Measured on the owner's machine 2026-08-23:
 * both records are on file under exactly those two names, and nothing in either
 * tree read either of them.
 *
 * Reading the vault is not shipping it. The rule that client must never break
 * is about the ARTIFACT: an id baked into config/google-signin.json goes to
 * every customer. A record read at runtime out of the vault on one machine
 * never leaves that machine, which is exactly why the vault is the right place
 * for it and a file in the installer is not.
 *
 * ORDER, and why.
 *
 *   1. TOOLSENABLED_GOOGLE_CLIENT_ID / _SECRET -- the environment. A developer
 *      or a test run overriding ONE launch, and the channel
 *      tools/google-signin-live-qa.mjs drives. It stays first: a harness that
 *      names a client must not silently get the machine's stored one instead.
 *   2. THE VAULT. The store the product's own credential catalogue names, it is
 *      protected by Windows rather than sitting in plain text, and putting a
 *      record there is a deliberate act. It outranks the files below because a
 *      google-signin.json is a file anything running as this user can drop into
 *      userData, and an unprotected drop-in must not outrank a protected record
 *      somebody stored on purpose.
 *   3. The per-installation file under userData -- what an owner can write
 *      without rebuilding anything (docs/GOOGLE-SIGN-IN-SETUP.md, step 4A).
 *   4. The shipped default in the artifact -- what a released build carries for
 *      customers who configure nothing.
 *
 * The first USABLE one wins, and which one it was is reported, so a screen can
 * say where the id came from.
 *
 * AN UNREADABLE VAULT DOES NOT VETO THE FILES, AND THAT IS DELIBERATE. A file
 * that EXISTS and is wrong stops the search, because falling past it would use
 * a different client than the one the person just edited and they would never
 * know. A vault that cannot be READ says nothing about whether it holds
 * anything -- so the search continues, and a file that does resolve is used.
 * What the unknown does change is the ENDING: if nothing resolves, the refusal
 * says the vault could not be read, never that it is empty. Cost is not what
 * decides this order, but it happens to agree: the vault is the only source
 * that spawns a process, and it is only reached when the environment did not
 * answer.
 */

const fs = require('node:fs')
const path = require('node:path')

const { vaultRecordValues, vaultRecordPresence } = require('./vault-presence.cjs')

const CONFIG_FILENAME = 'google-signin.json'
const ENVIRONMENT_KEY = 'TOOLSENABLED_GOOGLE_CLIENT_ID'
const ENVIRONMENT_SECRET_KEY = 'TOOLSENABLED_GOOGLE_CLIENT_SECRET'
const MAX_CONFIG_BYTES = 16 * 1024

/* The two vault records this product signs people in with. See the header for
   why they are not `google_client_id` -- that one is the capability layer's
   client and carries the owner's Drive and Gmail grants. */
const VAULT_CLIENT_ID_KEY = 'product_google_signin_client_id'
const VAULT_CLIENT_SECRET_KEY = 'product_google_signin_client_secret'

/* NOT A SOURCE. Asked ONLY when nothing resolved, and only for whether a record
   exists -- never for its value. It is the difference between "you have not set
   this up" and "you set up the other one", and the second sentence is the one
   that ends a run of failed attempts. */
const VAULT_CAPABILITY_CLIENT_ID_KEY = 'google_client_id'

/* Google's own format for a client id: a project number, a dash, an opaque
   label, then the fixed host. Checked rather than accepted as any string,
   because the failure a loose check produces is a browser window opening on a
   Google error page with no explanation on our side. */
const CLIENT_ID_PATTERN = /^[0-9]{1,30}-[0-9a-z]{1,80}\.apps\.googleusercontent\.com$/

/* The spellings a Desktop-app client secret arrives under. Google's own
   downloaded client_secret.json calls it `client_secret`; this file's own
   settings call it `clientSecret`, to match `clientId`. Both are read; `secret`
   is accepted too because it is what a person types. Only the FIRST one present
   is used, in this order, so a file carrying two never silently picks one. */
const SECRET_KEYS = Object.freeze(['clientSecret', 'client_secret', 'secret'])

/* Long enough for every secret format Google has issued (the current ones are
   `GOCSPX-` plus 28 characters); short enough that a file cannot smuggle a
   payload through this field. Whitespace is refused because a secret pasted with
   a stray newline fails at Google with an error nobody can read backwards. */
const MAX_CLIENT_SECRET_LENGTH = 256

function readClientSecret(source) {
  for (const key of SECRET_KEYS) {
    const raw = source[key]
    if (raw === undefined || raw === null) continue
    if (typeof raw !== 'string') {
      return refusal('GOOGLE_SIGNIN_CLIENT_SECRET_INVALID', `The Google sign-in setting "${key}" is not text, so Google sign-in was not offered.`)
    }
    const value = raw.trim()
    if (!value) continue
    /* THE VALUE IS NEVER IN THE MESSAGE. Only the key name, which is not one. */
    if (value.length > MAX_CLIENT_SECRET_LENGTH || /\s/.test(value)) {
      return refusal('GOOGLE_SIGNIN_CLIENT_SECRET_INVALID', `The Google sign-in setting "${key}" is not in the form Google issues, so Google sign-in was not offered.`)
    }
    return { ok: true, clientSecret: value }
  }
  return { ok: true, clientSecret: '' }
}

function refusal(code, reason) {
  return Object.freeze({ ok: false, code, reason })
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * A test identity provider, declared out loud or not at all.
 *
 * WHY THIS EXISTS. The real flow cannot be exercised end to end on a machine
 * that has no client id yet, and "it passed the unit tests" is not evidence that
 * a packaged product signs anybody in. So the endpoints can be repointed at a
 * local provider -- and the moment they are, the product SAYS SO on the sign-in
 * screen and in every result, because a screenshot of a test run that looks
 * identical to a real one is worse than no screenshot.
 *
 * IT CANNOT BE ENTERED BY ACCIDENT. All four endpoints must be present, all must
 * be loopback, and the file must carry the explicit acknowledgement below. Any
 * partial declaration is refused outright rather than half-applied, because a
 * half-applied override is one that sends a real Google code to a local port.
 */
function readTestProvider(value) {
  if (value === undefined || value === null) return { ok: true, testProvider: null }
  if (!isPlainObject(value)) {
    return refusal('GOOGLE_SIGNIN_CONFIG_INVALID', 'The Google sign-in settings on this computer describe a test provider in a form this program cannot read, so Google sign-in was not started.')
  }
  if (value.iUnderstandThisIsNotGoogle !== true) {
    return refusal(
      'GOOGLE_SIGNIN_TEST_PROVIDER_UNACKNOWLEDGED',
      'The Google sign-in settings point somewhere other than Google without saying so, so Google sign-in was not started.',
    )
  }
  const fields = ['authorizationEndpoint', 'tokenEndpoint', 'jwksUri', 'issuer']
  const resolved = {}
  for (const field of fields) {
    const raw = value[field]
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 500) {
      return refusal('GOOGLE_SIGNIN_TEST_PROVIDER_INCOMPLETE', `The test identity provider does not name ${field}, so Google sign-in was not started.`)
    }
    let url
    try { url = new URL(raw) } catch {
      return refusal('GOOGLE_SIGNIN_TEST_PROVIDER_INCOMPLETE', `The test identity provider's ${field} is not an address, so Google sign-in was not started.`)
    }
    /* LOOPBACK ONLY. A test override that can name any host on the internet is
       not a test seam, it is a way to point a shipped product's sign-in at
       somebody else's server. */
    if (field !== 'issuer' && url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') {
      return refusal(
        'GOOGLE_SIGNIN_TEST_PROVIDER_NOT_LOOPBACK',
        'A test identity provider may only run on this computer, so Google sign-in was not started.',
      )
    }
    resolved[field] = raw
  }
  return { ok: true, testProvider: Object.freeze(resolved) }
}

function readConfigFile(filePath) {
  let raw
  try {
    raw = fs.readFileSync(filePath)
  } catch (error) {
    /* ABSENT IS ABSENT, and it is not an error: most installations will never
       have this file. Anything OTHER than absent -- a permissions refusal, a
       directory where a file should be -- is reported, because "we could not
       read the settings" and "there are no settings" are different facts and
       only one of them is the customer's normal state. */
    if (error && error.code === 'ENOENT') return { ok: true, absent: true }
    return refusal('GOOGLE_SIGNIN_CONFIG_UNREADABLE', 'The Google sign-in settings on this computer could not be read, so Google sign-in was not offered.')
  }
  if (raw.length > MAX_CONFIG_BYTES) {
    return refusal('GOOGLE_SIGNIN_CONFIG_UNREADABLE', 'The Google sign-in settings file is larger than this program will read, so Google sign-in was not offered.')
  }
  let parsed
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    return refusal('GOOGLE_SIGNIN_CONFIG_INVALID', 'The Google sign-in settings on this computer are not readable, so Google sign-in was not offered.')
  }
  if (!isPlainObject(parsed)) {
    return refusal('GOOGLE_SIGNIN_CONFIG_INVALID', 'The Google sign-in settings on this computer are not in a form this program understands, so Google sign-in was not offered.')
  }
  const clientId = typeof parsed.clientId === 'string' ? parsed.clientId.trim() : ''
  if (!clientId) return { ok: true, absent: true }
  if (!CLIENT_ID_PATTERN.test(clientId)) {
    return refusal(
      'GOOGLE_SIGNIN_CLIENT_ID_INVALID',
      'The Google sign-in application id on this computer is not in the form Google issues, so Google sign-in was not offered. It should end in .apps.googleusercontent.com.',
    )
  }
  /* THE SECRET COMES FROM THE SAME FILE AS THE ID IT BELONGS TO, always. An id
     from one source paired with a secret from another is a pairing nobody chose,
     and Google answers it with `invalid_client` -- a failure whose cause is
     invisible from either file on its own. */
  const secret = readClientSecret(parsed)
  if (secret.ok !== true) return secret
  const provider = readTestProvider(parsed.testProvider)
  if (provider.ok !== true) return provider
  return {
    ok: true,
    absent: false,
    clientId,
    clientSecret: secret.clientSecret,
    testProvider: provider.testProvider,
  }
}

/**
 * The vault as a source: the two records, read together, in one vault process.
 *
 * FOUR ANSWERS, AND THE FOURTH IS THE ONE THIS CODEBASE KEEPS INSISTING ON.
 *
 *   absent    the vault was read and holds neither record
 *   resolved  both are there and both are in the shape Google issues
 *   refusal   the vault holds HALF a client, or one of the two is malformed
 *   unknown   the vault could not be read, so none of the above is established
 *
 * HALF A CLIENT STOPS THE SEARCH. An id with no secret cannot complete one real
 * sign-in -- Google answers `client_secret is missing` -- and falling through
 * would pair a vault id with a file secret, which is the mixed pairing the file
 * reader above already refuses to make. It is also, almost always, somebody who
 * pasted one of the two and believes they are done, and they are owed the
 * sentence that says which one is missing.
 */
async function readVaultPair({ capabilityRoot, stateRoot, readValues }) {
  const read = await readValues([VAULT_CLIENT_ID_KEY, VAULT_CLIENT_SECRET_KEY], { capabilityRoot, stateRoot })
  if (!read || read.readable !== true) {
    return {
      ok: true,
      unknown: true,
      store: read ? read.store : null,
      vaultCode: read && typeof read.code === 'string' ? read.code : 'VAULT_READ_FAILED',
    }
  }
  const clientId = read.values.get(VAULT_CLIENT_ID_KEY) || ''
  const clientSecret = read.values.get(VAULT_CLIENT_SECRET_KEY) || ''
  if (!clientId && !clientSecret) return { ok: true, absent: true, store: read.store }

  if (!clientId) {
    return refusal(
      'GOOGLE_SIGNIN_VAULT_CLIENT_ID_MISSING',
      `This installation’s vault holds ${VAULT_CLIENT_SECRET_KEY} but no ${VAULT_CLIENT_ID_KEY}, so Google sign-in was not offered. Store the client id from that same Google client under that name. Making an account on this computer works now and records the same thing.`,
    )
  }
  if (!CLIENT_ID_PATTERN.test(clientId)) {
    return refusal(
      'GOOGLE_SIGNIN_CLIENT_ID_INVALID',
      `The vault record ${VAULT_CLIENT_ID_KEY} is not in the form Google issues, so Google sign-in was not offered. It should end in .apps.googleusercontent.com.`,
    )
  }
  if (!clientSecret) {
    return refusal(
      'GOOGLE_SIGNIN_VAULT_CLIENT_SECRET_MISSING',
      `This installation’s vault holds ${VAULT_CLIENT_ID_KEY} but no ${VAULT_CLIENT_SECRET_KEY}, so Google sign-in was not offered. Google’s desktop clients refuse a sign-in that arrives without one. Store the secret from that same Google client under that name.`,
    )
  }
  /* THE SAME SHAPE RULE THE FILES GET, AND THE SAME SILENCE. `readClientSecret`
     never quotes the value it refuses; the sentence below names the record. */
  const secret = readClientSecret({ clientSecret })
  if (secret.ok !== true) {
    return refusal(
      'GOOGLE_SIGNIN_CLIENT_SECRET_INVALID',
      `The vault record ${VAULT_CLIENT_SECRET_KEY} is not in the form Google issues, so Google sign-in was not offered.`,
    )
  }
  return { ok: true, absent: false, clientId, clientSecret: secret.clientSecret, store: read.store }
}

/* The sentence a person gets when nothing resolved anywhere.
 *
 * IT IS BUILT, NOT PICKED FROM A LIST, because what is true differs: the vault
 * may have been read and found empty, may not have been readable at all, may
 * hold the OTHER Google client, or may not have been offered to this
 * resolution. Only the first clause is the same every time, and it is the one
 * addressed to the person who did not set this up and never will -- the door is
 * not open here, the other one works, nothing is wrong with them. */
function notConfiguredRefusal({ vault, capabilityClientIdPresent }) {
  const opening = 'Signing in with Google is not switched on in this version. Nothing is wrong with your computer or your Google account. Make an account on this computer instead; it does the same job here.'

  if (vault && vault.unknown === true) {
    const code = vault.vaultCode === 'VAULT_RESPONSE_INVALID'
      ? 'GOOGLE_SIGNIN_VAULT_RESPONSE_INVALID'
      : vault.vaultCode === 'VAULT_TIMEOUT'
        ? 'GOOGLE_SIGNIN_VAULT_TIMEOUT'
        : ['VAULT_TOOLING_ABSENT', 'VAULT_TOOLING_UNAVAILABLE'].includes(vault.vaultCode)
          ? 'GOOGLE_SIGNIN_VAULT_TOOLING_UNAVAILABLE'
          : 'GOOGLE_SIGNIN_VAULT_UNREADABLE'
    /* Do not repeat the child reader's prose here. The production reader uses
       fixed sentences today, but this boundary also accepts an injected reader
       and a future implementation could put stderr in `detail`. Only the
       closed code crosses into a person-facing error; each suffix below is a
       fixed literal and cannot contain a vault value. */
    const detail = code === 'GOOGLE_SIGNIN_VAULT_RESPONSE_INVALID'
      ? ' The vault program answered in a form this copy could not read.'
      : code === 'GOOGLE_SIGNIN_VAULT_TIMEOUT'
        ? ' The vault program did not answer before the bounded wait ended.'
        : code === 'GOOGLE_SIGNIN_VAULT_TOOLING_UNAVAILABLE'
          ? ' This copy could not start the local program that reads its vault.'
          : ''
    return refusal(
      code,
      `${opening} This copy could not read this installation’s own vault just now, so whether it holds a Google sign-in client is unknown. That is not the same as it holding none, and nothing here has decided that it does not.${detail}`,
    )
  }

  if (capabilityClientIdPresent === true) {
    return refusal(
      'GOOGLE_SIGNIN_VAULT_HOLDS_OTHER_CLIENT',
      `${opening} This installation’s vault does hold ${VAULT_CAPABILITY_CLIENT_ID_KEY}, but that is the Google client this program’s agents use for Drive, Gmail and Calendar, and it must not sign people in. Signing in needs its own Google client, stored as ${VAULT_CLIENT_ID_KEY} and ${VAULT_CLIENT_SECRET_KEY}.`,
    )
  }

  if (vault && vault.absent === true) {
    const where = vault.store ? ` The vault it read is ${vault.store}.` : ''
    return refusal(
      'GOOGLE_SIGNIN_NOT_CONFIGURED',
      `${opening} If you are setting this copy up, the two strings Google issues go in this installation’s own vault. They go under ${VAULT_CLIENT_ID_KEY} and ${VAULT_CLIENT_SECRET_KEY}. That vault was read just now and holds neither.${where}`,
    )
  }

  /* NO VAULT WAS OFFERED TO THIS RESOLUTION -- no capability payload was named,
     so nothing was measured and nothing is claimed about a store. */
  return refusal(
    'GOOGLE_SIGNIN_NOT_CONFIGURED',
    `${opening} If you are setting this copy up, the two strings Google issues go in this installation’s own vault, under ${VAULT_CLIENT_ID_KEY} and ${VAULT_CLIENT_SECRET_KEY}.`,
  )
}

/**
 * Resolve the Google sign-in configuration for this installation.
 *
 * Never throws. Every failure is a stated refusal with a code and a sentence,
 * and every refusal means the SAME thing to the caller: Google sign-in is not
 * available, say why, and offer the account on this computer.
 */
async function resolveGoogleSignInConfig({
  userDataDir = null,
  appRoot = null,
  env = process.env,
  /* THE VAULT IS ASKED ONLY IF A CALLER OFFERS ONE. `capabilityRoot` is where
     tools/secrets.ps1 lives and `stateRoot` is the state root whose vault/ is
     this installation's store; shell/main.cjs supplies both. A caller that
     supplies neither is not saying "the vault is empty" -- it is saying it has
     no vault to ask, and the refusal below is careful not to claim otherwise. */
  capabilityRoot = null,
  stateRoot = null,
  /* Injected so a test can drive every branch without a vault, a PowerShell, or
     a Windows account that can decrypt one. Defaults are the real readers. */
  readVaultValues = vaultRecordValues,
  probeVaultRecord = vaultRecordPresence,
} = {}) {
  const fromEnvironment = typeof env?.[ENVIRONMENT_KEY] === 'string' ? env[ENVIRONMENT_KEY].trim() : ''
  if (fromEnvironment) {
    if (!CLIENT_ID_PATTERN.test(fromEnvironment)) {
      return refusal(
        'GOOGLE_SIGNIN_CLIENT_ID_INVALID',
        `The ${ENVIRONMENT_KEY} setting on this computer is not a Google application id, so Google sign-in was not offered.`,
      )
    }
    /* Same source, same pair: an id named on the environment takes its secret
       from the environment or from nowhere. */
    const environmentSecret = readClientSecret({ clientSecret: env?.[ENVIRONMENT_SECRET_KEY] })
    if (environmentSecret.ok !== true) {
      return refusal('GOOGLE_SIGNIN_CLIENT_SECRET_INVALID', `The ${ENVIRONMENT_SECRET_KEY} setting on this computer is not in the form Google issues, so Google sign-in was not offered.`)
    }
    return Object.freeze({
      ok: true,
      clientId: fromEnvironment,
      clientSecret: environmentSecret.clientSecret,
      source: 'environment',
      testProvider: null,
    })
  }

  /* SOURCE 2: THE VAULT. Before the files, because a protected record somebody
     stored on purpose must not be outranked by a plain-text file anything
     running as this user can drop into userData. */
  let vault = null
  if (typeof capabilityRoot === 'string' && capabilityRoot) {
    vault = await readVaultPair({ capabilityRoot, stateRoot, readValues: readVaultValues })
    if (vault.ok !== true) return vault
    if (vault.absent === false) {
      return Object.freeze({
        ok: true,
        clientId: vault.clientId,
        clientSecret: vault.clientSecret,
        source: 'vault',
        /* A vault carries two strings, never four endpoints, so a vault-sourced
           build is always pointed at Google itself. */
        testProvider: null,
      })
    }
    /* absent or unknown: keep looking. `vault` is carried to the ending, which
       is the only place the difference between those two changes what is said. */
  }

  const candidates = []
  if (typeof userDataDir === 'string' && userDataDir) candidates.push({ source: 'installation', file: path.join(userDataDir, CONFIG_FILENAME) })
  if (typeof appRoot === 'string' && appRoot) candidates.push({ source: 'shipped', file: path.join(appRoot, 'config', CONFIG_FILENAME) })

  for (const candidate of candidates) {
    const read = readConfigFile(candidate.file)
    /* A file that EXISTS and is wrong stops the search. Falling through to the
       next source would silently use a different application id than the one
       the person just edited, and they would have no way to tell. */
    if (read.ok !== true) return read
    if (read.absent) continue
    return Object.freeze({
      ok: true,
      clientId: read.clientId,
      clientSecret: read.clientSecret || '',
      source: candidate.source,
      testProvider: read.testProvider || null,
    })
  }

  /* THE ABSENCE. Stated as a fact with the next step in it, not as an error.
   *
   * AND NOT AS A BUILD NOTE ADDRESSED TO US. "This copy has not been given a
   * Google sign-in application id yet" is a sentence about our release process,
   * printed to a customer, beside a button they cannot press -- and it is the
   * state EVERY copy is in today. "Application id" is not a thing a person has,
   * has not been given, or can do anything about. What they need to know first
   * is that this door is not open here and the other one works.
   *
   * WHAT THAT SENTENCE ALONE COST. It is also read by the one person who CAN do
   * something, and it told them nothing -- so ten deliberate attempts to
   * configure this looked identical to never having tried. The customer's
   * sentence still comes first and still ends with something that works today;
   * the store and the two record names follow it, addressed to whoever is
   * setting the copy up. Both readers now end with something to do.
   *
   * THE LAST QUESTION IS ASKED ONLY HERE, and only for presence. If the vault
   * was readable and held neither record, it is worth knowing whether it holds
   * the CAPABILITY layer's Google client instead, because "you set up the other
   * one" is a completely different sentence from "you set up nothing" and it is
   * the likelier of the two on a machine that has been used. It costs a second
   * vault process, on the refusal path only, and it decrypts nothing. */
  let capabilityClientIdPresent = null
  if (vault && vault.absent === true && typeof capabilityRoot === 'string' && capabilityRoot) {
    const probe = await probeVaultRecord(VAULT_CAPABILITY_CLIENT_ID_KEY, { capabilityRoot, stateRoot })
    capabilityClientIdPresent = probe && probe.readable === true ? probe.present === true : null
  }
  return notConfiguredRefusal({ vault, capabilityClientIdPresent })
}

module.exports = {
  resolveGoogleSignInConfig,
  readConfigFile,
  readTestProvider,
  CONFIG_FILENAME,
  ENVIRONMENT_KEY,
  ENVIRONMENT_SECRET_KEY,
  VAULT_CLIENT_ID_KEY,
  VAULT_CLIENT_SECRET_KEY,
  VAULT_CAPABILITY_CLIENT_ID_KEY,
  CLIENT_ID_PATTERN,
  SECRET_KEYS,
  MAX_CLIENT_SECRET_LENGTH,
}
