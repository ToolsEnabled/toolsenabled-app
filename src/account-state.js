/* THE SIGN-IN QUESTION: its words, and what the shell answered.
 *
 * This module holds no DOM and touches no stylesheet, for the same reason
 * src/setup-state.js does not: the sign-in surface decides what a customer sees
 * on the launch they form their opinion on, and a gate that can only be tested
 * by matching source text is a gate that can silently stop existing. Both were
 * tried on the tier screen; the source-matched one slipped through.
 *
 * WHAT THIS ACCOUNT IS, said here because the interface has to say it too.
 *
 * There are TWO WAYS IN, and the screen offers them in this order:
 *
 *   SIGN IN WITH GOOGLE, the first option. Google says who you are and the
 *   verified email address on your Google account becomes the name on the
 *   record. The password is typed into the system browser, not into this
 *   program, and this program stores no Google token of any kind -- see
 *   shell/google-signin.cjs.
 *
 *   AN ACCOUNT ON THIS COMPUTER, the second. It works with no network and for
 *   anybody who would rather not use Google. It is kept because removing it
 *   would leave those people with nothing.
 *
 * NEITHER IS A LOGIN TO CLAUDE OR CHATGPT and neither carries a subscription --
 * docs/design/SHIPMENT-PLAN.md blocker B14 records that taking a provider
 * SUBSCRIPTION login inside a third-party product is barred by those providers'
 * terms. Google sign-in is a different thing and B14 does not reach it: it asks
 * for `openid email profile`, which grants this product no access to anybody's
 * Drive, Gmail or Calendar, and it is the flow Google publishes for exactly this
 * purpose. Signing in answers "who is using this copy", which is what the agent
 * record needs and could not previously say.
 *
 * NOTHING IN THIS FILE HOLDS A SECRET. A password is read from a field, handed
 * straight to the shell, and dropped. It is never stored in a variable that
 * outlives the call, never put in `answers`, never written to localStorage, and
 * never included in a message. The state below is status words only.
 *
 * FAIL CLOSED. Every unrecognised, absent, or malformed reply resolves to
 * SIGNED OUT. There is no branch here on which a shape this module does not
 * understand produces a signed-in user.
 */

/* The password rule is ENFORCED IN THE MAIN PROCESS, in
   shell/product-account.cjs. The copy below exists so the form can say the rule
   before someone types a password that gets refused, and it is deliberately
   phrased as guidance. A renderer-side length check is a courtesy; it is not
   the check, and the shell refuses regardless of what this file believes. */
export const MIN_PASSWORD_LENGTH = 12

export const ACCOUNT_QUESTION = 'Who is using this copy?'
export const ACCOUNT_QUESTION_SUB = 'Sign in so your choices are kept for you. While Signed activity audit is on, the record of what your assistant does also says who asked for it.'

/* The same form accepts hosted sign-in and creates local accounts. Describe
   those separately so local-only privacy and recovery limits cannot be read
   as promises about ToolsEnabled's online account service. */
export const ACCOUNT_SCOPE_LEAD = 'ToolsEnabled sign-in and local accounts'
export const ACCOUNT_SCOPE_NOTICE = Object.freeze([
  'Creating an account here makes a local account on this computer. Nothing is sent anywhere when you create that local account. No email address is asked for, and no server holds it. There is also no password reset. If you forget its password, that local account cannot be recovered and you make a new one.',
  'To use your ToolsEnabled account, sign in with your toolsenabled.ai email and password, or Google. ToolsEnabled verifies that sign-in online. Connecting the computer you are driving for remote access is a separate step in Settings, under "Connect this computer".',
  'Signing in with Google instead puts the verified email address from your Google account on the record. Google is what checks it, not the computer you are driving.',
  'Either way it is not a login to Claude or ChatGPT, and it does not include a subscription to those services. Those stay in their own programs.',
  'It records who asked for a piece of work. It is not a lock on the computer you are driving. Anyone already signed in to the operating system as you can remove its local account data.',
])

export const ACCOUNT_SCOPE_SUBJECT_HERE = 'this computer'
export const ACCOUNT_SCOPE_SUBJECT_REMOTE = 'the computer you are driving'

/* The scope notice is one card, so its relay reading is a twin of the whole
   frozen table rather than a substitution performed on arbitrary copy. Only
   the first paragraph names the reader's desk; the other four already name
   the driven computer correctly and must remain byte-identical. */
export const ACCOUNT_SCOPE_NOTICE_REMOTE = Object.freeze([
  'Creating an account here makes a local account on the computer you are driving. Nothing is sent anywhere when you create that local account. No email address is asked for, and no server holds it. There is also no password reset. If you forget its password, that local account cannot be recovered and you make a new one.',
  ...ACCOUNT_SCOPE_NOTICE.slice(1),
])

export function accountScopeNotice({ subject = ACCOUNT_SCOPE_SUBJECT_HERE } = {}) {
  return subject === ACCOUNT_SCOPE_SUBJECT_REMOTE ? ACCOUNT_SCOPE_NOTICE_REMOTE : ACCOUNT_SCOPE_NOTICE
}

/* ---- SIGN IN WITH GOOGLE: the words, and the state behind the button ----
 *
 * The copy is HERE, next to the local account's copy, so the two can never
 * disagree about what either one is. Both are rendered by src/account-markup.js
 * and both are pinned by tools/test/product-account-surface.test.mjs.
 *
 * The sentence about scope is not marketing. `openid email profile` is the whole
 * request, and it is what keeps this product out of Google's sensitive-scope
 * review entirely -- so the promise on screen and the constant in
 * shell/google-signin.cjs are the same fact, and a test compares them. */
export const GOOGLE_SIGNIN_LABEL = 'Sign in with Google'
export const GOOGLE_SIGNIN_DESCRIPTION = 'A browser opens on the computer you are driving, and you choose your Google account there. The verified email address on it becomes the name on the record. Your Google password is typed into that browser and never into this program.'
export const GOOGLE_SIGNIN_SCOPE_NOTE = 'It asks Google for your name and email address only. It gets no access to your Drive, your Gmail or your Calendar, and this program keeps no Google password and no Google token.'

/* WHAT AN UNAVAILABLE GOOGLE OPTION LOOKS LIKE, and this is the case that
 * matters most on the machine this was built on: the owner has not created the
 * Google application id yet, so the answer today is "not configured".
 *
 * A missing configuration must NOT hide the button and must NOT produce a
 * button that fails when pressed. It produces a DISABLED option that says which
 * of those two it is, next to a local account that works right now. Absence
 * read as consent -- treating "no config" as "sign in some other way and don't
 * mention it" -- is this codebase's signature defect, and this is where it would
 * appear on the sign-in screen. */
const GOOGLE_UNAVAILABLE = Object.freeze({
  available: false,
  source: null,
  testProvider: null,
  code: 'MC_GOOGLE_SIGNIN_UNAVAILABLE',
  reason: 'This copy did not say whether signing in with Google is available, so it is not offered.',
})

/**
 * Normalize the shell's Google availability reply. Fails closed: anything this
 * build does not recognise is UNAVAILABLE with a reason, never "probably fine".
 */
export function readGoogleAvailability(value) {
  if (!isPlainObject(value)) return GOOGLE_UNAVAILABLE
  const localProfile = isPlainObject(value.localProfile) && value.localProfile.exists === true
    ? { localProfile:Object.freeze({ exists:true, available:value.localProfile.available === true,
      reason:typeof value.localProfile.reason === 'string' ? value.localProfile.reason.slice(0,1000) : null,
      testProvider:isPlainObject(value.localProfile.testProvider) && typeof value.localProfile.testProvider.issuer === 'string'
        ? Object.freeze({ issuer:value.localProfile.testProvider.issuer.slice(0,200) }) : null }) } : {}
  if (value.ok !== true || value.available !== true) {
    return Object.freeze({
      ...GOOGLE_UNAVAILABLE,
      ...localProfile,
      code: typeof value.code === 'string' ? value.code : GOOGLE_UNAVAILABLE.code,
      reason: typeof value.reason === 'string' && value.reason ? value.reason : GOOGLE_UNAVAILABLE.reason,
    })
  }
  return Object.freeze({
    available: true,
    ...localProfile,
    source: typeof value.source === 'string' ? value.source.slice(0, 40) : null,
    /* CARRIED SO THE SCREEN CAN SAY IT. A build pointed at a test identity
       provider must be visibly different from one pointed at Google; a
       screenshot that cannot be told apart from a real sign-in is evidence of
       nothing. */
    testProvider: isPlainObject(value.testProvider) && typeof value.testProvider.issuer === 'string'
      ? Object.freeze({ issuer: value.testProvider.issuer.slice(0, 200) })
      : null,
    code: null,
    reason: null,
  })
}

/** Ask the shell whether Google sign-in is available here. Never throws. */
export async function loadGoogleAvailability(scope = globalThis) {
  const bridge = accountBridge(scope)
  if (!bridge || typeof bridge.googleAvailability !== 'function') {
    return Object.freeze({
      ...GOOGLE_UNAVAILABLE,
      code: 'MC_GOOGLE_SIGNIN_ABSENT',
      reason: 'This copy of the program does not offer signing in with Google. Making an account on the computer you are driving does the same job.',
    })
  }
  try {
    const availability = readGoogleAvailability(await bridge.googleAvailability())
    return Object.freeze({
      ...availability,
      ...(availability.localProfile && typeof bridge.googleLocalProfile !== 'function' ? {
        localProfile:Object.freeze({ ...availability.localProfile, available:false,
          reason:'This copy cannot open a previous Google profile.' })
      } : {}),
      canCancel: typeof bridge.googleCancel === 'function',
    })
  } catch {
    return Object.freeze({
      ...GOOGLE_UNAVAILABLE,
      code: 'MC_GOOGLE_SIGNIN_READ_FAILED',
      reason: 'The application did not answer whether signing in with Google is available, so it is not offered.',
    })
  }
}

const SIGNED_OUT = Object.freeze({
  available: false,
  signedIn: false,
  accountCount: 0,
  displayName: null,
  username: null,
  /* Present on the signed-out shape too, so every consumer sees the same keys
     whichever branch it got. A field that only exists on the happy path is a
     field somebody reads as `undefined` on the unhappy one. */
  signInMethod: null,
  verifiedEmail: null,
  expiresAtMs: null,
  canPersistSession: false,
  code: 'MC_ACCOUNT_SHELL_ABSENT',
  reason: 'This page is running in a browser rather than the installed application, so there is no account on it to sign in to.',
})

export function accountBridge(scope = globalThis) {
  const bridge = scope?.mcAccount
  if (!bridge || typeof bridge.current !== 'function' || typeof bridge.signIn !== 'function') return null
  return bridge
}

/* Exported ONLY so its array guard can be tested directly.
 *
 * Mutation testing showed that removing `!Array.isArray(value)` changes no
 * observable behaviour through the public API: both call sites compare against
 * the literal `true`, so an array -- which answers `undefined` to every field --
 * is refused anyway. The guard is kept because src/setup-state.js documents this
 * exact trap on the sibling channel, where an array DID read as "available,
 * nothing recorded yet". Depth that no test can see is depth nobody can tell
 * from an accident, so it is tested here rather than left to survive a mutant
 * and be reported as "equivalent".
 */
export function isPlainObject(value) {
  /* Arrays are rejected explicitly. `typeof [] === 'object'`, so the obvious
     guard lets one through and an array then answers `undefined` to every field
     -- which reads as "available, nobody signed in yet" and would offer a
     button guaranteed to fail. src/setup-state.js rejects arrays for the same
     reason; this is the same rule on a different channel. */
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function boundedName(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.slice(0, 64)
}

/* An address gets its own bound rather than reusing the 64 above. A display
   name that is cut short is untidy; an EMAIL ADDRESS that is cut short is a
   different address, and this one is an identity the person is being shown so
   they can check it is theirs. 320 is the addressing limit. */
function boundedEmail(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 320) return null
  return trimmed
}

/**
 * Normalize an `availability()` and a `current()` reply into one state.
 *
 * Either argument being absent, malformed, or an error resolves to signed out
 * WITH the reason, rather than to a cheerful default. `available: false` means
 * the surface states why and offers no button; it never means "assume fine".
 */
export function readAccountState(availability, current) {
  if (!isPlainObject(availability)) return SIGNED_OUT
  if (availability.ok !== true) {
    return Object.freeze({
      ...SIGNED_OUT,
      code: typeof availability.code === 'string' ? availability.code : 'MC_ACCOUNT_UNAVAILABLE',
      reason: typeof availability.reason === 'string' && availability.reason
        ? availability.reason
        : 'This copy cannot read its accounts.',
      /* Deliberately kept even on the failure path: an account file that cannot
         be read still means accounts EXIST, and a surface that showed "create
         your first account" here would invite someone to overwrite the one they
         could not read. */
      accountCount: Number.isSafeInteger(availability.accountCount) && availability.accountCount > 0 ? availability.accountCount : 0,
    })
  }

  const accountCount = Number.isSafeInteger(availability.accountCount) && availability.accountCount >= 0
    ? availability.accountCount
    : 0
  const base = {
    available: true,
    accountCount,
    canPersistSession: availability.canPersistSession === true,
    code: null,
    reason: null,
  }

  if (isPlainObject(current) && current.ok === false && current.code === 'HOSTED_ACCOUNT_STATUS_UNAVAILABLE') {
    return Object.freeze({ ...SIGNED_OUT, ...base, available: false,
      code: current.code,
      reason: 'Your sign-in could not be verified right now. Check your connection and retry.',
    })
  }

  /* Anything other than a well-formed object saying `signedIn: true` is signed
     out. The comparison is to the literal `true` rather than truthy, so a
     string, a number, or the object itself cannot stand in for it. */
  if (!isPlainObject(current) || current.signedIn !== true || !isPlainObject(current.account)) {
    return Object.freeze({ ...SIGNED_OUT, ...base, signedIn: false })
  }
  const username = boundedName(current.account.username)
  if (!username) {
    return Object.freeze({ ...SIGNED_OUT, ...base, signedIn: false })
  }
  return Object.freeze({
    ...base,
    signedIn: true,
    username,
    displayName: boundedName(current.account.displayName) || username,
    /* THE ID, and why it is here rather than derived from the username.
     *
     * The spawn ledger records `account:<id>`, so a screen showing a person
     * their own runs has to compare against the id. The username cannot stand
     * in for it: product-login-build's rule is that the id survives a
     * display-name change and the username does not, so a view keyed on the
     * username would silently re-attribute somebody's history the day they
     * renamed themselves.
     *
     * Shape-checked, not merely copied. A malformed id is `null` rather than a
     * string that would then be compared against ledger records and match
     * nothing -- which would render as "none of these runs are yours" instead
     * of as the failure it is. */
    accountId: typeof current.account.id === 'string' && /^[0-9a-f]{32}$/.test(current.account.id)
      ? current.account.id
      : null,
    /* WHICH DOOR THIS ACCOUNT USES, and the default is the conservative one.
     *
     * Only the literal string `google` from the shell makes this `google`;
     * anything else -- absent, misspelt, a number, a build that predates the
     * field -- reads as `local`. That direction is deliberate: a local account
     * shown as a Google one would tell somebody Google had verified them when
     * nothing had, and would offer to change a password that does exist. The
     * other way round costs a person one visible option. */
    signInMethod: ['google', 'hosted'].includes(current.account.signInMethod) ? current.account.signInMethod : 'local',
    /* Shown only on a Google account, and only when the shell said so. It is
       the same string as the username; it is carried separately so the screen
       can say "verified by Google" about it rather than guessing from an `@`. */
    verifiedEmail: current.account.signInMethod === 'google' ? boundedEmail(current.account.email) : null,
    expiresAtMs: Number.isSafeInteger(current.session?.expiresAtMs) ? current.session.expiresAtMs : null,
  })
}

/**
 * Ask the shell, and never throw at the caller.
 *
 * A rejected invoke -- a closed window, a refused sender, a channel that does
 * not exist in this build -- resolves to signed out with a code, because a
 * sign-in surface that crashes on a failed read is a surface nobody can use to
 * recover.
 */
export async function loadAccountState(scope = globalThis) {
  const bridge = accountBridge(scope)
  if (!bridge) return SIGNED_OUT
  let availability = null
  let current = null
  try {
    availability = await bridge.availability()
  } catch {
    return Object.freeze({ ...SIGNED_OUT, code: 'MC_ACCOUNT_READ_FAILED', reason: 'The application did not report whether the computer you are driving holds an account.' })
  }
  try {
    current = await bridge.current()
  } catch {
    current = null
  }
  return readAccountState(availability, current)
}

/**
 * Normalize any reply to an action into something a surface can render.
 *
 * The shell already answers `{ok, code, reason}`. This exists for the shapes it
 * cannot answer with: a rejected promise, a bridge that is not there, and a
 * reply from a build that predates the channel. All three become a refusal with
 * a code, never a silent success.
 */
export function readActionResult(value) {
  if (!isPlainObject(value)) {
    return Object.freeze({ ok: false, code: 'MC_ACCOUNT_NO_REPLY', reason: 'The application did not answer.' })
  }
  if (value.ok !== true) {
    return Object.freeze({
      ok: false,
      code: typeof value.code === 'string' ? value.code : 'MC_ACCOUNT_REFUSED',
      /* IT USED TO STOP AT "and did not say why", which is where a person is
         left with nothing. This is the last-resort sentence on the sign-in
         screen, so it is also the one most likely to be the only thing they
         get, and it now names the two things worth trying. */
      reason: typeof value.reason === 'string' && value.reason ? value.reason : 'The application refused, and did not say why. Check what you typed and try again. If it keeps refusing, close ToolsEnabled on the computer you are driving and open it a second time there.',
    })
  }
  return Object.freeze({
    ok: true,
    code: null,
    reason: null,
    /* False means the sign-in is good for this run only, because the OS
       keystore would not hold it. Carried through so the surface can say so
       rather than letting the person discover it at the next launch. */
    persisted: value.persisted !== false,
    /* SAME REASON, SECOND FACT, AND IT WAS BEING DROPPED HERE.
       signOutEverywhere answers { ok: true, revoked: false } when there was
       nothing to revoke -- it signed out locally and bumped no epoch. This
       function rebuilds the reply from a fixed field list, so `revoked` never
       reached the view, which then printed "Signed out everywhere. Any saved
       sign-in taken from this computer earlier is now refused." A person was
       told other sessions were dead while every copied sign-in still worked.

       `ok` means NOTHING WENT WRONG. It does not mean IT HAPPENED. The verb
       already reported both; only this rebuild collapsed them. Left undefined
       when the verb does not report it, so no other caller changes shape. */
    revoked: value.revoked === undefined ? undefined : value.revoked !== false,
    ...(typeof value.allRequested === 'boolean' ? { allRequested:value.allRequested } : {}),
    ...(typeof value.stepUpRequired === 'boolean' ? { stepUpRequired:value.stepUpRequired } : {}),
    ...(typeof value.remoteEnded === 'boolean' ? { remoteEnded: value.remoteEnded } : {}),
    ...(typeof value.localCleared === 'boolean' ? { localCleared: value.localCleared } : {}),
    /* The kept names of account files that were set aside (T1520). */
    ...(Array.isArray(value.keptAs) ? { keptAs: Object.freeze(value.keptAs.filter(name => typeof name === 'string' && name).slice(0, 4).map(name => name.slice(0, 200))) } : {}),
  })
}

/**
 * Normalize the reply to a Google sign-in attempt.
 *
 * FAIL CLOSED, AND THE FAILURE IS THE POINT. Six things can go wrong and every
 * one of them arrives here as `ok: false` with a code and a sentence: no
 * network, Google refusing, a token that did not verify, the loopback port
 * being refused, the browser not opening, and the person closing the tab. None
 * of them is a reason to sign anybody in, and there is no branch below that
 * treats a shape this build does not recognise as success.
 */
export function readGoogleSignInResult(value) {
  const base = readActionResult(value)
  if (!base.ok) return base
  return Object.freeze({
    ...base,
    /* Whether an account was made just now, so the screen can greet rather than
       welcome back. Only an explicit `true` counts. */
    created: isPlainObject(value) && value.created === true,
    /* SAID OUT LOUD WHEN IT IS TRUE. A run against the local test identity
       provider must never read on screen as a run against Google. */
    usedTestProvider: isPlainObject(value) && value.usedTestProvider === true,
  })
}

/* ---- WHAT BELONGS TO THE SIGNED-IN ACCOUNT ----
 *
 * Three separate questions, kept separate all the way to the screen because
 * collapsing them is how a product tells a person something false about his own
 * money:
 *
 *   1. Is a payment method ATTACHED to this account? A binding this product
 *      wrote. It names a vault record; it is not the record.
 *   2. Can this installation SEE that record in its own vault? A different
 *      question with a different answer -- on this machine the card was entered
 *      into the engine checkout's vault and the installed product resolves its
 *      own under userData.
 *   3. Could the vault be read AT ALL? If not, 1 and 2 are unknown, and unknown
 *      is not "no".
 *
 * A single boolean can only answer one of the three, and whichever one it
 * answers, the other two degrade to "no card on file" -- which is a sentence
 * about the owner's money that the product would be making up.
 */

const NO_ACCOUNT_DATA = Object.freeze({
  ok: false,
  code: 'MC_ACCOUNT_DATA_UNAVAILABLE',
  reason: 'This copy could not read what belongs to this account.',
  settingCount: 0,
  settingKeys: Object.freeze([]),
  adopted: null,
  paymentMethod: null,
})

function boundedKeyList(value) {
  if (!Array.isArray(value)) return Object.freeze([])
  const keys = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 256) continue
    keys.push(entry)
    if (keys.length >= 512) break
  }
  return Object.freeze(keys)
}

/**
 * Normalize the shell's account-data reply. Fails closed: an unrecognised shape
 * is "could not read", never "nothing there".
 */
export function readAccountData(value) {
  if (!isPlainObject(value) || value.ok !== true) {
    return Object.freeze({
      ...NO_ACCOUNT_DATA,
      code: isPlainObject(value) && typeof value.code === 'string' ? value.code : NO_ACCOUNT_DATA.code,
      reason: isPlainObject(value) && typeof value.reason === 'string' && value.reason ? value.reason : NO_ACCOUNT_DATA.reason,
    })
  }
  const settingKeys = boundedKeyList(value.settingKeys)
  return Object.freeze({
    ok: true,
    code: null,
    reason: null,
    settingCount: Number.isSafeInteger(value.settingCount) && value.settingCount >= 0 ? value.settingCount : settingKeys.length,
    settingKeys,
    adopted: isPlainObject(value.adopted) && Number.isSafeInteger(value.adopted.atMs)
      ? Object.freeze({ atMs: value.adopted.atMs, count: Number.isSafeInteger(value.adopted.count) ? value.adopted.count : 0 })
      : null,
    /* The vault KEY NAME and when it was attached. There is no field here that
       could carry a card value, and there must never be one: this object is
       rendered into the page. */
    paymentMethod: isPlainObject(value.paymentMethod) && typeof value.paymentMethod.vaultKey === 'string'
      ? Object.freeze({
        vaultKey: value.paymentMethod.vaultKey.slice(0, 120),
        attachedAtMs: Number.isSafeInteger(value.paymentMethod.attachedAtMs) ? value.paymentMethod.attachedAtMs : null,
      })
      : null,
  })
}

const NO_PAYMENT_PRESENCE = Object.freeze({
  ok: false,
  attached: false,
  /* `null`, never `false`. See the three questions above. */
  present: null,
  checked: false,
  code: 'MC_PAYMENT_PRESENCE_UNAVAILABLE',
  detail: 'This copy could not check whether the attached record is in its vault, so whether a card is on file is unknown.',
})

/**
 * Normalize the shell's payment-presence reply.
 *
 * `present` is TRUE only when the shell said so explicitly. Every other shape,
 * including one this build does not recognise, resolves to unknown -- and
 * `checked: false` is what the screen must say out loud.
 */
export function readPaymentPresence(value) {
  if (!isPlainObject(value) || value.ok !== true) return NO_PAYMENT_PRESENCE
  if (value.attached !== true) {
    return Object.freeze({
      ok: true,
      attached: false,
      present: false,
      checked: true,
      code: typeof value.code === 'string' ? value.code : 'ACCOUNT_PAYMENT_NOT_ATTACHED',
      detail: null,
    })
  }
  const checked = value.checked === true
  return Object.freeze({
    ok: true,
    attached: true,
    vaultKey: typeof value.vaultKey === 'string' ? value.vaultKey.slice(0, 120) : null,
    attachedAtMs: Number.isSafeInteger(value.attachedAtMs) ? value.attachedAtMs : null,
    /* Only an explicit `true` from a check that actually happened is true, and
       only an explicit `false` from one is false. Anything else is null. */
    present: checked && value.present === true ? true : checked && value.present === false ? false : null,
    checked,
    code: typeof value.code === 'string' ? value.code : 'MC_PAYMENT_PRESENCE_UNKNOWN',
    detail: typeof value.detail === 'string' ? value.detail : null,
  })
}

/**
 * Ask the shell for everything that belongs to the signed-in account. Never
 * throws; every failure resolves to a stated unknown.
 */
export async function loadAccountBelongings(scope = globalThis) {
  const bridge = accountBridge(scope)
  if (!bridge || typeof bridge.data !== 'function') {
    return Object.freeze({ data: NO_ACCOUNT_DATA, payment: NO_PAYMENT_PRESENCE })
  }
  let data
  try { data = readAccountData(await bridge.data()) } catch { data = NO_ACCOUNT_DATA }
  let payment
  try {
    payment = typeof bridge.paymentPresence === 'function'
      ? readPaymentPresence(await bridge.paymentPresence())
      : NO_PAYMENT_PRESENCE
  } catch { payment = NO_PAYMENT_PRESENCE }
  return Object.freeze({ data, payment })
}

/**
 * The seam the first-run walkthrough uses.
 *
 * Deliberately narrow: promises in, status words out, no DOM, and no field that
 * could carry a credential. src/views/setup.js serialises its answers to
 * localStorage and shows them on a review page, so a password reaching that
 * object would be written to disk in the clear. Nothing returned here can be
 * one -- there is no field for it.
 */
export function accountStep(scope = globalThis) {
  const bridge = accountBridge(scope)
  return Object.freeze({
    available: Boolean(bridge),
    canCancelSignIn: typeof bridge?.googleCancel === 'function',
    load: () => loadAccountState(scope),
    create: async request => {
      if (!bridge) return readActionResult(null)
      try { return readActionResult(await bridge.create(request)) } catch { return readActionResult(null) }
    },
    signIn: async request => {
      if (!bridge) return readActionResult(null)
      try { return readActionResult(await bridge.signIn(request)) } catch { return readActionResult(null) }
    },
    signOut: async () => {
      if (!bridge) return readActionResult(null)
      try { return readActionResult(await bridge.signOut()) } catch { return readActionResult(null) }
    },
    /* NO ARGUMENT, and that is the design rather than an omission: what comes
       back from Google is verified in the main process, and a page that could
       hand in an email address would be a page that could sign in as anybody.
       A build without the channel refuses rather than pretending. */
    googleAvailability: () => loadGoogleAvailability(scope),
    googleUrl: async () => {
      if (typeof bridge?.googleUrl !== 'function') return { ok: false }
      try { return await bridge.googleUrl() } catch { return { ok: false } }
    },
    googleSignIn: async () => {
      if (!bridge || typeof bridge.googleSignIn !== 'function') {
        return Object.freeze({ ok: false, code: 'MC_GOOGLE_SIGNIN_ABSENT', reason: 'This copy of the program does not offer signing in with Google.' })
      }
      try { return readGoogleSignInResult(await bridge.googleSignIn()) } catch { return readGoogleSignInResult(null) }
    },
    googleLocalProfile: async () => {
      if (!bridge || typeof bridge.googleLocalProfile !== 'function') {
        return Object.freeze({ ok:false, code:'MC_GOOGLE_LOCAL_PROFILE_ABSENT', reason:'This copy cannot open a previous Google profile.' })
      }
      try { return readGoogleSignInResult(await bridge.googleLocalProfile()) } catch { return readGoogleSignInResult(null) }
    },
    googleCancel: async () => {
      if (!bridge || typeof bridge.googleCancel !== 'function') {
        return { ok: false, cancelled: false, reason: 'This installed copy cannot cancel the Google sign-in. Close the browser window on the computer you are driving to cancel it.' }
      }
      try { return await bridge.googleCancel() } catch {
        return { ok: false, cancelled: false, reason: 'The Google sign-in was not confirmed cancelled. Close the browser window on the computer you are driving to cancel it.' }
      }
    },
  })
}
