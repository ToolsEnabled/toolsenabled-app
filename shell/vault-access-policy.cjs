'use strict'

/* THE OWNER'S DECISIONS ABOUT HIS OWN VAULT RECORDS: what each one is CALLED on
 * screen and to an assistant, and which principals may read it.
 *
 * WHY THIS IS A FILE OF ITS OWN, BESIDE THE APPROVALS FILE RATHER THAN INSIDE
 * THE SETTINGS RECORD. Two reasons, both measured:
 *
 *  - It must survive a generation change. The settings record and the renderer's
 *    preference store live with the running copy; this lives under the STATE
 *    root's `state/` directory, which is the same place
 *    shell/vault-credential-page.cjs keeps `vault-removal-approvals.json` and
 *    is what the owner keeps when a new generation is promoted over the old
 *    one. A nickname that vanished on upgrade would re-expose the real record
 *    name, which is the one thing the nickname exists to hide.
 *  - It is read on a path that must not load the renderer's store at all. The
 *    decision below is consulted where a tool reads a VALUE, in the main
 *    process, with no window in the picture.
 *
 * THE DEFAULT IS ALLOW, AND THAT IS A DELIBERATE CHOICE WITH A REASON.
 * This file is an OPT-OUT list: a record the owner has never ruled on is
 * readable, exactly as it was before this file existed. Fail-closed-by-default
 * would have meant that promoting this change locks every existing credential
 * on every installed copy -- including the ones sign-in reads -- until the
 * owner re-enables each one by hand. That is not a security posture, it is an
 * outage. What the owner asked for is the ability to "enable/disable agent
 * access to certain credentials", and a deny he SET is honoured absolutely.
 *
 * AN UNREADABLE POLICY IS NOT AN ABSENT ONE, and this is where the default
 * flips. An absent file means "no decisions yet" and allows. A file that EXISTS
 * and cannot be parsed means the owner's decisions are on disk and unavailable,
 * and allowing there would silently discard every deny he set -- a corrupted
 * byte would re-open every credential he closed. So a present-but-unreadable
 * policy refuses reads, by name, with VAULT_POLICY_UNREADABLE. The product
 * already keeps this distinction elsewhere; see
 * tools/test/product-settings-unreadable-is-not-absent.test.mjs.
 */

const fs = require('fs')
const path = require('path')

const POLICY_VERSION = 1

/* The record-key shape the vault itself accepts, kept identical to NAME_RE in
   src/vault-credentials-settings.js and VAULT_KEY_RE in shell/vault-presence.cjs
   so a name that is legal to store is legal to rule on. */
const NAME_RE = /^[A-Za-z0-9_.-]{1,120}$/

/* Who a rule may name. Roles are bare words ("builder"); agents arrive as the
   tree's own ids, which carry a colon in `account:...` form and hyphens in
   node ids. Anything outside this shape is refused rather than stored, so a
   malformed principal cannot sit in the file matching nothing. */
const PRINCIPAL_RE = /^[A-Za-z0-9_.:-]{1,120}$/

const NICKNAME_MAX = 60

/* A nickname is shown WHERE THE REAL NAME WOULD BE, including to an assistant,
   so it may not itself look like a vault key that something downstream could
   try to resolve, and it may not carry markup or control characters. */
const NICKNAME_RE = /^[^\u0000-\u001f<>"'\\]{1,60}$/

const POLICY_CODES = Object.freeze({
  READ: 'VAULT_POLICY_READ',
  ABSENT: 'VAULT_POLICY_ABSENT',
  UNREADABLE: 'VAULT_POLICY_UNREADABLE',
  DENIED: 'VAULT_ACCESS_DENIED',
  NAME_INVALID: 'VAULT_POLICY_NAME_INVALID',
  PRINCIPAL_INVALID: 'VAULT_POLICY_PRINCIPAL_INVALID',
  NICKNAME_INVALID: 'VAULT_POLICY_NICKNAME_INVALID',
  NO_STATE_ROOT: 'VAULT_POLICY_NO_STATE_ROOT',
})

/** Where the decisions live. Beside the removal approvals, deliberately. */
function policyFilePath(stateRoot) {
  if (typeof stateRoot !== 'string' || !stateRoot) return null
  return path.join(stateRoot, 'state', 'vault-access-policy.json')
}

function emptyPolicy() {
  return { version: POLICY_VERSION, records: Object.create(null) }
}

function validRecord(entry) {
  if (!entry || typeof entry !== 'object') return null
  const nickname = typeof entry.nickname === 'string' && NICKNAME_RE.test(entry.nickname)
    ? entry.nickname
    : null
  const access = Object.create(null)
  if (entry.access && typeof entry.access === 'object') {
    for (const [principal, allowed] of Object.entries(entry.access)) {
      if (PRINCIPAL_RE.test(principal) && typeof allowed === 'boolean') access[principal] = allowed
    }
  }
  return { nickname, access }
}

/**
 * Read the owner's decisions.
 *
 * @returns {{readable: boolean, code: string, policy: object|null, file: string|null}}
 *   `readable:false` with UNREADABLE means decisions exist and could not be
 *   read -- callers must treat that as a refusal, never as "no rules".
 */
function readPolicy(stateRoot, { fileSystem = fs } = {}) {
  const file = policyFilePath(stateRoot)
  if (!file) return { readable: false, code: POLICY_CODES.NO_STATE_ROOT, policy: null, file: null }
  let raw
  try {
    raw = fileSystem.readFileSync(file, 'utf8')
  } catch (error) {
    /* ENOENT is the ordinary first-run answer and the ONLY failure that means
       "no decisions yet". Every other read error means the file is there and we
       could not have it. */
    if (error && error.code === 'ENOENT') {
      return { readable: true, code: POLICY_CODES.ABSENT, policy: emptyPolicy(), file }
    }
    return { readable: false, code: POLICY_CODES.UNREADABLE, policy: null, file }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { readable: false, code: POLICY_CODES.UNREADABLE, policy: null, file }
  }
  if (!parsed || parsed.version !== POLICY_VERSION || !parsed.records || typeof parsed.records !== 'object') {
    return { readable: false, code: POLICY_CODES.UNREADABLE, policy: null, file }
  }
  const policy = emptyPolicy()
  for (const [name, entry] of Object.entries(parsed.records)) {
    if (!NAME_RE.test(name)) continue
    const record = validRecord(entry)
    if (record) policy.records[name] = record
  }
  return { readable: true, code: POLICY_CODES.READ, policy, file }
}

/* Atomic, 0600, same shape as writeApprovals in shell/vault-credential-page.cjs.
   A half-written policy is a policy that could drop a deny. */
function writePolicy(stateRoot, policy, { fileSystem = fs } = {}) {
  const file = policyFilePath(stateRoot)
  if (!file) return { ok: false, code: POLICY_CODES.NO_STATE_ROOT }
  const records = Object.create(null)
  for (const [name, entry] of Object.entries(policy?.records || {})) {
    if (!NAME_RE.test(name)) continue
    const record = validRecord(entry)
    if (!record) continue
    /* A record carrying neither a nickname nor a single rule is not written.
       This keeps the file to what the owner actually decided rather than one
       entry per credential he has ever had. */
    if (record.nickname === null && Object.keys(record.access).length === 0) continue
    records[name] = record
  }
  fileSystem.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  fileSystem.writeFileSync(temporary, JSON.stringify({ version: POLICY_VERSION, records }), { encoding: 'utf8', mode: 0o600 })
  fileSystem.renameSync(temporary, file)
  return { ok: true, code: POLICY_CODES.READ, file }
}

function mutate(stateRoot, name, change, options = {}) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    return { ok: false, code: POLICY_CODES.NAME_INVALID }
  }
  const current = readPolicy(stateRoot, options)
  /* Refusing to write over an unreadable policy is the same rule as refusing to
     read one: the decisions we cannot see must not be overwritten by the few we
     can. */
  if (!current.readable) return { ok: false, code: current.code }
  const policy = current.policy
  const existing = policy.records[name] || { nickname: null, access: Object.create(null) }
  const next = change({ nickname: existing.nickname, access: { ...existing.access } })
  if (next.error) return { ok: false, code: next.error }
  policy.records[name] = { nickname: next.nickname, access: next.access }
  const written = writePolicy(stateRoot, policy, options)
  if (!written.ok) return written
  return { ok: true, code: POLICY_CODES.READ, name, record: policy.records[name] }
}

/** Give one record a secret nickname, or clear it by passing null/''. */
function setNickname(stateRoot, name, nickname, options = {}) {
  return mutate(stateRoot, name, (entry) => {
    if (nickname === null || nickname === '') return { ...entry, nickname: null }
    if (typeof nickname !== 'string' || !NICKNAME_RE.test(nickname.trim())) {
      return { error: POLICY_CODES.NICKNAME_INVALID }
    }
    return { ...entry, nickname: nickname.trim() }
  }, options)
}

/** Enable or disable one principal against one record. */
function setAccess(stateRoot, name, principal, allowed, options = {}) {
  return mutate(stateRoot, name, (entry) => {
    if (typeof principal !== 'string' || !PRINCIPAL_RE.test(principal)) {
      return { error: POLICY_CODES.PRINCIPAL_INVALID }
    }
    if (typeof allowed !== 'boolean') return { error: POLICY_CODES.PRINCIPAL_INVALID }
    const access = { ...entry.access }
    access[principal] = allowed
    return { ...entry, access }
  }, options)
}

/**
 * THE DECISION. May `principal` read `name`?
 *
 * Total and pure: it takes the answer `readPolicy` gave and returns a verdict
 * with a reason, so the caller never has to know the default rule. It is the
 * single place the opt-out model is expressed.
 *
 * @param {{readable: boolean, code: string, policy: object|null}} read
 * @returns {{allowed: boolean, code: string, detail: string}}
 */
function mayRead(read, name, principal) {
  if (!read || read.readable !== true) {
    return {
      allowed: false,
      code: POLICY_CODES.UNREADABLE,
      detail: 'This computer holds decisions about which credentials may be read and could not read them, '
        + 'so nothing is handed over. That is not the same as having no rules.',
    }
  }
  const record = read.policy?.records?.[name]
  if (!record) return { allowed: true, code: POLICY_CODES.ABSENT, detail: 'No rule names this credential.' }
  const ruled = record.access?.[principal]
  if (ruled === false) {
    return {
      allowed: false,
      code: POLICY_CODES.DENIED,
      detail: 'The owner of this computer turned off access to this credential for you.',
    }
  }
  return { allowed: true, code: POLICY_CODES.READ, detail: 'The owner has not turned this one off for you.' }
}

/**
 * What this record is CALLED to whoever is asking.
 *
 * A nickname replaces the real name outright -- it is not a label beside it --
 * because the owner's words were "give credentials secret nicknames so that
 * they arent visible". Returning the real name alongside would defeat it.
 */
function displayName(read, name) {
  if (!read || read.readable !== true) return name
  const nickname = read.policy?.records?.[name]?.nickname
  return typeof nickname === 'string' && nickname ? nickname : name
}

/** Every record the owner has ruled on, for the page's matrix. Names only. */
function ruledRecords(read) {
  if (!read || read.readable !== true) return []
  return Object.keys(read.policy?.records || {}).sort()
}

module.exports = {
  POLICY_VERSION,
  POLICY_CODES,
  NICKNAME_MAX,
  policyFilePath,
  readPolicy,
  writePolicy,
  setNickname,
  setAccess,
  mayRead,
  displayName,
  ruledRecords,
}
