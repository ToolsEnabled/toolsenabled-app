'use strict'

/* VERIFYING WHAT GOOGLE SAID. The whole of the trust in "Sign in with Google"
 * lives in this file.
 *
 * An id_token is a JWT: three base64url parts, the third a signature over the
 * first two. Everything a product wants from it -- which Google account this is,
 * what its email address is, whether Google has verified that address -- sits in
 * the SECOND part, which is not encrypted and which anybody can write. Reading
 * that part without checking the third is the single most common way desktop
 * OAuth is got wrong, and it is not a subtle failure: an attacker who can put a
 * response in front of the app signs in as anyone by typing their email into a
 * JSON object.
 *
 * So this file does the arithmetic. It fetches Google's public keys, finds the
 * one the token names, checks the RSA signature over the exact bytes that were
 * signed, and only then reads a claim. Then it checks the claims that decide
 * whether a correctly-signed token is a token for US: the issuer (Google), the
 * audience (this application's client id, and no other), the expiry, and the
 * nonce this run generated.
 *
 * THE ALGORITHM IS PINNED, and that is not paranoia about a hypothetical. Two
 * historical JWT attacks are both spelled `alg`: `alg: "none"`, where the
 * signature is empty and a naive verifier accepts it, and `alg: "HS256"` on a
 * verifier that then uses the RSA PUBLIC key -- which is published -- as an HMAC
 * secret. Both are defeated by refusing to take the algorithm from the token.
 * RS256 is what Google issues; anything else is refused before a key is fetched.
 *
 * NOTHING HERE THROWS AT THE CALLER, and nothing here returns a partial answer.
 * Every path produces either a fully verified identity or a refusal with a code
 * and a sentence. There is no third shape, because a third shape is what a
 * caller eventually treats as success.
 *
 * NO TOKEN VALUE IS EVER RETURNED, LOGGED OR PUT IN A MESSAGE. The refusal
 * reasons below are written from the CHECK that failed, never from the input:
 * an error message quoting the token is an error message that puts a credential
 * in a log file.
 *
 * Every dependency is injected, so this is testable without Electron and without
 * the network.
 */

const crypto = require('node:crypto')

/* The two spellings Google uses for its own issuer. Both appear in real tokens
   and both are correct; an exact-match list rather than a suffix test, because
   `endsWith('accounts.google.com')` also accepts `evil-accounts.google.com`. */
const GOOGLE_ISSUERS = Object.freeze(['https://accounts.google.com', 'accounts.google.com'])
const GOOGLE_JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs'

/* Clocks disagree. Sixty seconds is enough for an ordinary desktop that has not
   synchronised recently and short enough that an expired token is not usable in
   any meaningful sense. It is applied to expiry and to issued-at alike. */
const CLOCK_SKEW_MS = 60 * 1000
/* A token issued far in the future is not a clock problem, it is a forgery or a
   badly broken machine, and either way signing somebody in on it is wrong. */
const MAX_FUTURE_IAT_MS = 5 * 60 * 1000
/* A JWT this size is not one Google minted. Bounded before any parsing so a
   hostile response cannot make this process do arbitrary work. */
const MAX_TOKEN_BYTES = 16 * 1024
const MAX_JWKS_BYTES = 128 * 1024

/* How long a fetched key set is reused. Google rotates these; an hour is well
   inside the rotation window and means an ordinary sign-in makes one network
   call, not two. An UNKNOWN kid forces a refetch regardless (see below), which
   is what actually handles rotation -- the TTL is only a courtesy. */
const JWKS_TTL_MS = 60 * 60 * 1000
/* ...but a token naming a kid that does not exist must not become a way to make
   this app hammer Google. ONE forced refetch per key set, then the answer is a
   stated refusal until the TTL brings a new set in.
 *
 * A TIME-BASED limit was tried first and was WRONG, and the test is what showed
 * it: with a cache loaded seconds earlier, a token signed by a freshly rotated
 * key was refused for a whole minute -- the exact moment the refetch exists to
 * cover. Counting per key set instead makes the rotation case immediate and
 * still bounds the work at one extra request. */
const JWKS_FORCED_REFETCHES_PER_KEY_SET = 1

const MAX_SUBJECT_LENGTH = 255
const MAX_EMAIL_LENGTH = 320
const MAX_NAME_LENGTH = 64

function refusal(code, reason) {
  return Object.freeze({ ok: false, code, reason })
}

/* base64url, decoded strictly.
 *
 * `Buffer.from(value, 'base64')` is famously permissive: it skips characters it
 * does not recognise rather than refusing, so a token with punctuation spliced
 * into the middle decodes to something plausible instead of failing. The
 * signature check would catch that anyway -- but the HEADER is parsed before any
 * signature exists to check, so a lenient decode there chooses the code path. */
function decodeSegment(segment) {
  if (typeof segment !== 'string' || segment.length === 0) return null
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null
  try {
    return Buffer.from(segment, 'base64url')
  } catch {
    return null
  }
}

function parseJsonSegment(segment) {
  const raw = decodeSegment(segment)
  if (!raw) return null
  let parsed
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return parsed
}

/**
 * A key set, cached, with the two behaviours a cache on a verification path has
 * to have: it expires, and an unknown key id forces one refetch rather than a
 * refusal, because that is exactly what a key rotation looks like from here.
 */
function createJwksCache({ fetchImpl, jwksUri = GOOGLE_JWKS_URI, now = () => Date.now() } = {}) {
  let keys = null
  let fetchedAtMs = 0
  let lastAttemptMs = 0
  /* Reset when the TTL brings in a new key set, spent when an unknown key id
     forces a refetch. Never reset by the forced refetch itself -- doing that
     would let a stream of tokens naming invented key ids fetch forever. */
  let forcedRefetches = 0

  async function load() {
    lastAttemptMs = now()
    let response
    try {
      response = await fetchImpl(jwksUri, { method: 'GET', headers: { accept: 'application/json' } })
    } catch {
      return refusal('GOOGLE_JWKS_UNREACHABLE', 'This computer could not reach Google to check the sign-in, so nobody was signed in.')
    }
    if (!response || response.ok !== true) {
      return refusal('GOOGLE_JWKS_REFUSED', 'Google did not return the keys needed to check the sign-in, so nobody was signed in.')
    }
    let text
    try {
      text = await response.text()
    } catch {
      return refusal('GOOGLE_JWKS_REFUSED', 'Google’s reply could not be read, so nobody was signed in.')
    }
    if (typeof text !== 'string' || text.length > MAX_JWKS_BYTES) {
      return refusal('GOOGLE_JWKS_REFUSED', 'Google’s reply was not in a form this program will read, so nobody was signed in.')
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      return refusal('GOOGLE_JWKS_REFUSED', 'Google’s reply was not readable, so nobody was signed in.')
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.keys)) {
      return refusal('GOOGLE_JWKS_REFUSED', 'Google’s reply did not contain any signing keys, so nobody was signed in.')
    }
    const usable = parsed.keys.filter(key => key && typeof key === 'object'
      && key.kty === 'RSA' && typeof key.kid === 'string' && key.kid.length > 0
      && typeof key.n === 'string' && typeof key.e === 'string'
      /* `use` and `alg` are optional in JWKS, but when Google states them they
         are `sig`/`RS256`, and a key marked for ENCRYPTION must never be used to
         verify a signature. Absent is allowed; contradicting is not. */
      && (key.use === undefined || key.use === 'sig')
      && (key.alg === undefined || key.alg === 'RS256'))
    if (usable.length === 0) {
      return refusal('GOOGLE_JWKS_REFUSED', 'Google returned no usable signing keys, so nobody was signed in.')
    }
    keys = usable
    fetchedAtMs = now()
    return { ok: true }
  }

  return {
    /** The key with this id, fetching or refetching only when it has to. */
    async find(kid) {
      const fresh = keys !== null && now() - fetchedAtMs < JWKS_TTL_MS
      if (!fresh) {
        forcedRefetches = 0
        const loaded = await load()
        if (loaded.ok !== true) return loaded
      }
      let match = keys.find(key => key.kid === kid)
      if (!match && forcedRefetches < JWKS_FORCED_REFETCHES_PER_KEY_SET) {
        /* An unknown kid on a fresh cache is what a key rotation looks like.
           One refetch, then a stated refusal -- never a silent accept and never
           an unbounded retry. */
        forcedRefetches += 1
        const reloaded = await load()
        if (reloaded.ok !== true) return reloaded
        match = keys.find(key => key.kid === kid)
      }
      if (!match) {
        return refusal('GOOGLE_TOKEN_KEY_UNKNOWN', 'Google signed the reply with a key this computer could not find, so the sign-in was not accepted.')
      }
      return { ok: true, key: match }
    },
    /* Tests only: prove the TTL and the rate limit rather than take them on
       faith. Nothing in a shipped path calls this. */
    stateForTests: () => ({ cached: keys !== null, fetchedAtMs, lastAttemptMs, forcedRefetches }),
  }
}

function boundedString(value, limit) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > limit) return null
  return trimmed
}

/* The same stripping shell/product-account.cjs applies to a display name, for
   the same reason: this string arrives from outside and is shown in the
   interface, and a name carrying a bidi override renders as a different name.
   Written as escapes rather than as the characters themselves. */
function cleanName(value) {
  if (typeof value !== 'string') return null
  /* WRITTEN AS ESCAPES, NEVER AS THE CHARACTERS THEMSELVES. An earlier version
     of this line was authored with the literal characters in it, which made this
     file read as binary to grep and put an invisible bidi override into the
     product's own source -- the precise trick the strip exists to defeat.
     shell/product-account.cjs carries the same warning over the same class. */
  const cleaned = value.replace(new RegExp('[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]', 'g'), '').trim()
  if (!cleaned) return null
  const truncated = cleaned.slice(0, MAX_NAME_LENGTH)
  /* JavaScript slices strings by UTF-16 code unit. Do not leave half of a
     surrogate pair at the boundary: it renders as a replacement character in
     an otherwise valid Google display name. */
  return /[\uD800-\uDBFF]$/.test(truncated) ? truncated.slice(0, -1) : truncated
}

/* An email address, checked to the extent that matters here: it is Google's
   assertion, not ours, so this is a SHAPE check that stops something unusable
   becoming an account name -- not an attempt to validate deliverability.
   ASCII-only and one `@`, for the same confusable reason usernames are ASCII. */
function normalizeVerifiedEmail(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().toLowerCase()
  if (trimmed.length < 3 || trimmed.length > MAX_EMAIL_LENGTH) return null
  if (!/^[a-z0-9](?:[a-z0-9._%+-]*[a-z0-9])?@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(trimmed)) return null
  return trimmed
}

/**
 * Verify an id_token and return the identity inside it, or a refusal.
 *
 * ORDER MATTERS AND IS DELIBERATE: shape, then algorithm, then SIGNATURE, then
 * claims. Nothing that costs a network call happens before the cheap refusals,
 * and no claim is read as if it meant anything before the signature over it has
 * been checked.
 */
async function verifyIdToken(token, {
  clientId,
  nonce,
  issuers = GOOGLE_ISSUERS,
  now = () => Date.now(),
  jwks,
  fetchImpl,
  jwksUri = GOOGLE_JWKS_URI,
} = {}) {
  if (typeof clientId !== 'string' || clientId.length === 0) {
    return refusal('GOOGLE_SIGNIN_NOT_CONFIGURED', 'This copy has no Google sign-in application id, so a reply from Google could not be checked against one.')
  }
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_BYTES) {
    return refusal('GOOGLE_TOKEN_MALFORMED', 'Google’s reply did not contain a sign-in token this program can read, so nobody was signed in.')
  }
  const parts = token.split('.')
  if (parts.length !== 3) {
    return refusal('GOOGLE_TOKEN_MALFORMED', 'Google’s reply was not in the expected form, so nobody was signed in.')
  }
  const header = parseJsonSegment(parts[0])
  if (!header) {
    return refusal('GOOGLE_TOKEN_MALFORMED', 'Google’s reply could not be read, so nobody was signed in.')
  }
  /* THE ALGORITHM IS OURS, NOT THE TOKEN'S. `alg: none` and `alg: HS256`
     against a published RSA public key are both real attacks and both die
     here, before a key is fetched and before a claim is read. */
  if (header.alg !== 'RS256') {
    return refusal('GOOGLE_TOKEN_ALG_REFUSED', 'The sign-in reply was not signed the way Google signs them, so it was not accepted.')
  }
  if (typeof header.kid !== 'string' || header.kid.length === 0 || header.kid.length > 200) {
    return refusal('GOOGLE_TOKEN_MALFORMED', 'The sign-in reply did not name a signing key, so it was not accepted.')
  }
  const signature = decodeSegment(parts[2])
  if (!signature || signature.length === 0) {
    return refusal('GOOGLE_TOKEN_UNSIGNED', 'The sign-in reply carried no signature, so it was not accepted.')
  }

  const cache = jwks || createJwksCache({ fetchImpl, jwksUri, now })
  const found = await cache.find(header.kid)
  if (found.ok !== true) return found

  let publicKey
  try {
    publicKey = crypto.createPublicKey({
      key: { kty: 'RSA', n: found.key.n, e: found.key.e },
      format: 'jwk',
    })
  } catch {
    return refusal('GOOGLE_TOKEN_KEY_UNUSABLE', 'Google’s signing key could not be read on this computer, so the sign-in was not accepted.')
  }

  /* The bytes that were signed are the first two segments and the dot between
     them, exactly as they arrived -- NOT a re-encoding of the parsed objects.
     Re-serialising would change key order and whitespace and verify nothing. */
  const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii')
  let signatureValid = false
  try {
    signatureValid = crypto.verify('RSA-SHA256', signingInput, publicKey, signature)
  } catch {
    signatureValid = false
  }
  if (!signatureValid) {
    return refusal('GOOGLE_TOKEN_SIGNATURE_INVALID', 'The sign-in reply did not carry a valid Google signature, so nobody was signed in.')
  }

  /* ---- only now do the claims mean anything ---- */

  const claims = parseJsonSegment(parts[1])
  if (!claims) {
    return refusal('GOOGLE_TOKEN_MALFORMED', 'The signed sign-in reply could not be read, so nobody was signed in.')
  }
  if (typeof claims.iss !== 'string' || !issuers.includes(claims.iss)) {
    return refusal('GOOGLE_TOKEN_ISSUER_REFUSED', 'The sign-in reply did not come from Google, so it was not accepted.')
  }
  /* A CORRECTLY SIGNED TOKEN FOR SOMEBODY ELSE'S APPLICATION IS NOT A SIGN-IN
     HERE. Google signs every application's tokens with the same keys, so the
     signature alone says only "Google issued this" -- the audience is what says
     it was issued to US. Without this check, any Google-signed token from any
     other application signs a person in. An array audience must be exactly this
     one entry; a token addressed to several applications is refused rather than
     searched for a match. */
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (audience.length !== 1 || audience[0] !== clientId) {
    return refusal('GOOGLE_TOKEN_AUDIENCE_REFUSED', 'The sign-in reply was issued for a different application, so it was not accepted.')
  }
  if (claims.azp !== undefined && claims.azp !== clientId) {
    return refusal('GOOGLE_TOKEN_AUDIENCE_REFUSED', 'The sign-in reply was authorised for a different application, so it was not accepted.')
  }
  const at = now()
  if (!Number.isFinite(claims.exp) || at >= claims.exp * 1000 + CLOCK_SKEW_MS) {
    return refusal('GOOGLE_TOKEN_EXPIRED', 'The sign-in reply had already expired by the time it arrived, so nobody was signed in.')
  }
  if (!Number.isFinite(claims.iat) || claims.iat * 1000 - MAX_FUTURE_IAT_MS > at) {
    return refusal('GOOGLE_TOKEN_NOT_YET_VALID', 'The sign-in reply is dated in the future, so it was not accepted. This computer’s clock may be wrong.')
  }
  if (Number.isFinite(claims.nbf) && at + CLOCK_SKEW_MS < claims.nbf * 1000) {
    return refusal('GOOGLE_TOKEN_NOT_YET_VALID', 'The sign-in reply is not valid yet, so it was not accepted. This computer’s clock may be wrong.')
  }
  /* THE NONCE IS WHAT MAKES THIS SIGN-IN THIS SIGN-IN. Without it a token
     captured from an earlier, legitimate sign-in replays. Compared in constant
     time and length-checked first, because timingSafeEqual throws on a length
     mismatch and a thrown comparison is a comparison that did not happen. */
  if (typeof nonce !== 'string' || nonce.length === 0) {
    return refusal('GOOGLE_TOKEN_NONCE_MISSING', 'This sign-in had nothing to match Google’s reply against, so it was not accepted.')
  }
  const presented = typeof claims.nonce === 'string' ? claims.nonce : ''
  const expectedBytes = Buffer.from(nonce, 'utf8')
  const presentedBytes = Buffer.from(presented, 'utf8')
  if (presentedBytes.length !== expectedBytes.length || !crypto.timingSafeEqual(presentedBytes, expectedBytes)) {
    return refusal('GOOGLE_TOKEN_NONCE_MISMATCH', 'Google’s reply did not match the sign-in this program started, so it was not accepted.')
  }

  const subject = boundedString(claims.sub, MAX_SUBJECT_LENGTH)
  if (!subject) {
    return refusal('GOOGLE_TOKEN_NO_SUBJECT', 'Google’s reply did not say which account it was for, so nobody was signed in.')
  }
  const email = normalizeVerifiedEmail(claims.email)
  if (!email) {
    return refusal('GOOGLE_TOKEN_NO_EMAIL', 'Google’s reply did not include an email address, so there was no identity to sign in as.')
  }
  /* UNVERIFIED IS NOT VERIFIED. Google states this per address, and on some
     Workspace configurations it is false. An unverified address is a claim by
     whoever holds the account, not by Google, and this product's identity is
     the address -- so accepting it would let one person take an identity that
     names another. */
  if (claims.email_verified !== true) {
    return refusal('GOOGLE_TOKEN_EMAIL_UNVERIFIED', 'Google has not verified the email address on that account, so it cannot be used to sign in here.')
  }

  return Object.freeze({
    ok: true,
    identity: Object.freeze({
      provider: 'google',
      /* The stable one. Google guarantees `sub` never changes and is never
         reused; an email address can be changed by its owner. The account is
         keyed on this and DISPLAYS the email. */
      subject,
      email,
      emailVerified: true,
      displayName: cleanName(claims.name) || email,
      /* Set only here, only after everything above passed. shell/product-account.cjs
         refuses an identity that does not carry it, so a future caller that
         assembles an identity object by hand -- from an unverified token, say --
         fails closed instead of signing somebody in. */
      assurance: 'id_token-verified',
    }),
  })
}

module.exports = {
  verifyIdToken,
  createJwksCache,
  normalizeVerifiedEmail,
  GOOGLE_ISSUERS,
  GOOGLE_JWKS_URI,
  CLOCK_SKEW_MS,
  JWKS_TTL_MS,
  JWKS_FORCED_REFETCHES_PER_KEY_SET,
  IDENTITY_ASSURANCE: 'id_token-verified',
}
