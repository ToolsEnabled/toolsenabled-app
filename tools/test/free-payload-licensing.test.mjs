// WHAT THE FREE PRODUCT DOES ABOUT LICENSING, MEASURED ON THE BYTES A CUSTOMER GETS.
//
// THE DECISION THIS FILE HOLDS, STATED ONCE:
//
//     THE FREE PAYLOAD SHIPS NO LICENSING CODE AT ALL -- NOT ISSUANCE, NOT THE
//     TIER TABLE, AND NOT VERIFICATION EITHER.
//
// The last clause is the one that surprises people, so here is the evidence
// rather than the assertion. src/lib/entitlement.js declares GATED_CAPABILITIES
// as a closed, frozen set with exactly ONE member, `hosted-relay`, and that
// member declares its own enforcement point: `enforcedAt:
// src/lib/providers/hosted-relay-entitlement.js connect()` -- a server the
// VENDOR runs. A licence therefore buys admission to someone else's machine.
// Verification performed on the customer's own machine would decide nothing
// that machine controls; it would only add a place where a customer-supplied
// answer about what a customer has paid for could be believed. So the free
// build does not verify licences because there is nothing here for a licence to
// unlock, and the one thing it does unlock is decided elsewhere.
//
// WHY THIS SUITE EXISTS WHEN FOUR OTHERS ALREADY COVER LICENSING. They all
// measure the SOURCE TREE. tests/license-trust-pinning.test.js and
// tests/license-trust-anchor-shipped.test.js (engine tree) prove the crypto
// refuses a self-minted licence; tests/entitlement-report.js proves the seam
// answers correctly. Every one of them runs in a tree where entitlement.js,
// providers/license.js and license-store.js EXIST. None of them can see what a
// customer received. A fix can be present in the tree and absent from the
// artifact -- that has already happened on this project, where a shipped
// app.asar contained zero of a fix's seven identifiers while the source tree
// carried all seven. This file measures the staged payload, and it RUNS it.
//
// WHY IT RUNS THE PAYLOAD INSTEAD OF READING IT. Dead code and live code grep
// identically. A path-absence check passes over a payload whose seam has been
// replaced by something that reports every install as broken, and over one whose
// diagnostic throws on load. So the behavioural tests below copy the payload to
// a temp directory -- a fresh install, with no repository around it -- and ask
// the shipped program what it is entitled to.
//
// THE ABSENCE CASE IS TESTED FIRST AND ON PURPOSE. This codebase's recurring
// defect is absence read as consent. Licensing has two absence traps pointing in
// opposite directions, and both are here: an install with NO licence must read
// as healthy-and-complete rather than degraded (E1), and an install carrying a
// licence record nobody verified must NOT read as entitled (E2).
//
// Run: node --test tools/test/free-payload-licensing.test.mjs

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const BOUNDARY = JSON.parse(readFileSync(path.join(REPO_ROOT, 'config', 'payload-boundary.json'), 'utf8'))

const STAGED_ROOT = path.join(REPO_ROOT, 'capability')
const PAYLOAD_ROOTS = ['capability', 'release/win-unpacked/resources/capability']
  .map((relative) => path.join(REPO_ROOT, relative))
  .filter((root) => existsSync(root))

// The three modules the owner ruled paid on 2026-08-11. Named as payload-relative
// paths because that is how the boundary manifest names them and how they would
// appear in the payload; a rename shows up as a failure to find the file rather
// than as a silent pass on a path that no longer exists.
const LICENSING_MODULES = Object.freeze([
  'src/lib/entitlement.js',
  'src/lib/providers/license.js',
  'src/lib/license-store.js'
])

// The admission code that DOES decide a paid capability. It runs on the vendor's
// relay host and must never be in a customer payload: a customer who holds the
// admission logic holds both sides of the conversation.
const ADMISSION_MODULE = 'src/lib/providers/hosted-relay-entitlement.js'

// LITERALS FROM THE COMMERCIAL TIER TABLE, chosen because each is meaningless
// outside it. Prices are deliberately NOT matched as bare numbers -- "19" and
// "299" occur in ordinary code and a scanner that cries wolf is a scanner that
// gets deleted. `positive control` below proves this list actually detects the
// table rather than merely failing to find it.
const TIER_TABLE_MARKERS = Object.freeze([
  'monthlyUsd',
  'annualUsd',
  'seatMinimum',
  'requiresLicense',
  'GATED_CAPABILITIES',
  'toolsenabled.operator-cloud.v1',
  'toolsenabled.team.v1',
  'Operator Cloud'
])

// A verbatim excerpt of what must not ship, used ONLY as the positive control's
// planted defect. It lives in this file rather than being read from the engine
// tree because this repository does not contain the engine tree, and a control
// that silently skips when its fixture is missing is not a control.
const PLANTED_TIER_TABLE = [
  'const TIERS = Object.freeze({',
  "  operator: Object.freeze({ id: 'operator', label: 'Operator Cloud', monthlyUsd: 19, annualUsd: 190,",
  "    requiresLicense: true, productId: 'toolsenabled.operator-cloud.v1' }),",
  "  team: Object.freeze({ id: 'team', monthlyUsd: 299, seatMinimum: 3,",
  "    productId: 'toolsenabled.team.v1' })",
  '})',
  'const GATED_CAPABILITIES = Object.freeze({})'
].join('\n')

function walk(root) {
  const found = []
  const visit = (dir, relative) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name)
      const next = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) visit(absolute, next)
      else if (entry.isFile()) found.push({ relative: next, absolute })
    }
  }
  visit(root, '')
  return found
}

/* The scanner, as a pure function over a directory, so the positive control can
 * run the EXACT code that reports on the payload. A control that exercises a
 * second, similar-looking implementation proves only that the second one works. */
function scanForTierTable(root) {
  const hits = []
  for (const file of walk(root)) {
    if (statSync(file.absolute).size > 8 * 1024 * 1024) continue
    const text = readFileSync(file.absolute).toString('latin1')
    for (const marker of TIER_TABLE_MARKERS) {
      if (text.includes(marker)) hits.push(`${file.relative}: ${marker}`)
    }
  }
  return hits.sort()
}

/* A fresh install: the payload and nothing else. Copied rather than used in
 * place because two of the tests below WRITE into it -- planting a forged
 * licence record is the attack, and doing that inside capability/ would corrupt
 * the payload every other guard measures. */
function freshInstall(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'free-payload-licensing-'))
  /* `force` only forgives a directory that is already gone; on Windows a file
   * whose handle has been closed but not yet released still answers EBUSY, and
   * without retries that lands as `failureType: 'hookFailed'` against whichever
   * test happened to finish last -- a teardown race reported as a product
   * failure. MEASURED 2026-09-07 at 4ba0ceac, whole-suite run: "EBUSY: resource
   * busy or locked, rmdir '...\\free-payload-licensing-zH0rdY\\install'" failed
   * the E1 case, whose own assertions had all passed. */
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const root = path.join(directory, 'install')
  cpSync(STAGED_ROOT, root, { recursive: true })
  return root
}

/* Ask the SHIPPED diagnostic, in a separate process rooted at the install, with
 * no repository on the path. Returns the entitlement block doctor() reports --
 * the thing a customer's health screen actually renders. */
function entitlementOf(installRoot) {
  const script =
    'const status = require(' + JSON.stringify(path.join(installRoot, 'src', 'lib', 'system-status.js')) + ');' +
    'process.stdout.write(JSON.stringify(status.doctor().entitlement));'
  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: installRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000
  })
  return JSON.parse(out)
}

/* Try to load a module the way an attacker on their own machine would: from the
 * install, by require. Returns the error code, or 'LOADED' -- and 'LOADED' is
 * the finding, so this never throws on the interesting outcome. */
function loadFromInstall(installRoot, relativeModule) {
  const script =
    'try { require(' + JSON.stringify(path.join(installRoot, relativeModule)) + ');' +
    " process.stdout.write('LOADED') }" +
    " catch (error) { process.stdout.write(String(error && error.code || 'THREW-WITHOUT-CODE')) }"
  return execFileSync(process.execPath, ['-e', script], {
    cwd: installRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000
  })
}

/* ---------- A. the decision, held where the build reads it ---------- */

test('A the boundary classifies all three licensing modules PAID, and nothing pending', () => {
  const paid = BOUNDARY.paid?.paths ?? []
  const open = BOUNDARY.open?.paths ?? []
  const pending = Object.keys(BOUNDARY.pending ?? {})

  for (const module of LICENSING_MODULES.concat(ADMISSION_MODULE)) {
    assert.ok(paid.includes(module),
      `${module} is not classified paid in config/payload-boundary.json. Without that entry the ` +
        'payload boundary guard would not stop a build that re-imports it -- it would report it ' +
        'as an ordinary open file.')
    assert.equal(open.includes(module), false,
      `${module} is classified OPEN. That publishes the commercial tier table and the licence ` +
        'issuer with the free product.')
  }

  // Pending is a legitimate development state in general -- it means "a lane
  // proposes removing this and it still ships". It is NOT a legitimate state for
  // these three: they were pending, they shipped, and the removal landed. A
  // pending entry naming one of them again would be the gate reporting a green
  // exit code while the tier table sits in the payload, which is exactly the
  // disagreement between prose and exit code that --ship exists to close.
  for (const module of LICENSING_MODULES) {
    assert.equal(pending.includes(module), false,
      `${module} is back in "pending". check-payload-boundary.mjs exits 0 without --ship for a ` +
        'pending file, so this would ship with every dev gate green.')
  }
})

/* ---------- B and C. the bytes ---------- */

test('B no payload root contains a licensing module', () => {
  assert.ok(PAYLOAD_ROOTS.length > 0,
    'no payload root exists in this checkout -- run `node tools/pack-capability-layer.mjs` first. ' +
      'Reporting "clean" about bytes that were never staged is the failure this refuses.')

  for (const root of PAYLOAD_ROOTS) {
    const staged = new Set(walk(root).map((file) => file.relative))
    assert.ok(staged.size > 0, `${root} staged no files`)
    const present = LICENSING_MODULES.concat(ADMISSION_MODULE).filter((module) => staged.has(module))
    assert.deepEqual(present, [],
      `${root} ships licensing code: ${present.join(', ')}. tools/pack-capability-layer.mjs is a ` +
        'TEXT scan over whole file bodies, so the cause is a require() specifier naming one of ' +
        'these in some staged file -- including one inside a comment. Making the require lazy, ' +
        'or moving it into a function nobody calls, stages the file identically. Only removing ' +
        'the specifier text removes the module.')
  }
})

test('C positive control -- the tier-table scanner detects a planted tier table', (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'tier-table-control-'))
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  mkdirSync(path.join(directory, 'src', 'lib'), { recursive: true })
  writeFileSync(path.join(directory, 'src', 'lib', 'entitlement.js'), `${PLANTED_TIER_TABLE}\n`)
  // An unrelated file, so a scanner that flags everything fails this control too.
  writeFileSync(path.join(directory, 'src', 'lib', 'innocent.js'), 'module.exports = { hello: 1 }\n')

  const hits = scanForTierTable(directory)
  assert.ok(hits.length >= 5,
    `the scanner found ${hits.length} marker(s) in a file containing the tier table verbatim. ` +
      'Until this control passes, an empty result from the payload means nothing.')
  assert.ok(hits.every((hit) => hit.startsWith('src/lib/entitlement.js:')),
    `the scanner flagged a file that carries no tier table: ${hits.join(', ')}`)
})

test('C the commercial tier table is absent from every shipped byte', () => {
  assert.ok(PAYLOAD_ROOTS.length > 0, 'no payload root exists in this checkout')
  for (const root of PAYLOAD_ROOTS) {
    const hits = scanForTierTable(root)
    assert.deepEqual(hits, [],
      `${root} ships the commercial tier table: ${hits.join(', ')}. The payload directory is ` +
        'plain, unminified .js next to a trivially extractable app.asar, so shipping it IS ' +
        'publishing our prices and product ids.')
  }
})

/* ---------- D and E. what a fresh install says about itself ---------- */

test('D a fresh install reports community, full-function and ok -- run, not read', (t) => {
  const install = freshInstall(t)
  const entitlement = entitlementOf(install)
  const seen = JSON.stringify(entitlement)

  // REASON FIRST, because it is the field that tells the two failures apart and
  // therefore the one whose message is worth reading. Ordering assertions by how
  // much their failure explains is not cosmetic here: the first version of this
  // test failed its planted defect on `licensed` and printed
  // "undefined !== false", which names nothing and would have sent the next
  // reader to the wrong file.
  assert.equal(entitlement.reason, 'no-licensing-in-this-build',
    `the free build reported reason ${JSON.stringify(entitlement.reason)} instead of ` +
      '"no-licensing-in-this-build". "entitlement-unreadable" means licensing IS present and ' +
      `BROKEN -- a real defect being reported as a normal build. Whole block: ${seen}`)
  assert.equal(entitlement.licensing, 'not-in-this-build',
    `the free build reported licensing ${JSON.stringify(entitlement.licensing)}. Whole block: ${seen}`)

  // EVERY FIELD THE FREE BLOCK PROMISES MUST BE PRESENT. A surface that renders
  // this block reads `licensed` and `tier`; an undefined there renders as blank
  // rather than as "Community", and a missing field is how a fail-soft catch
  // block silently replaces a complete answer with a stub.
  for (const field of ['ok', 'tier', 'tierLabel', 'licensed', 'active', 'licenseChecked',
    'unlicensedInstall', 'unlicensedInstallStatement', 'gatedCapabilities']) {
    assert.notEqual(entitlement[field], undefined,
      `the free build's entitlement block has no "${field}". A customer-facing surface renders ` +
        `this block; a missing field renders as nothing at all. Whole block: ${seen}`)
  }

  assert.equal(entitlement.ok, true,
    'the free product reports itself as NOT ok. Having bought nothing is this product\'s normal, ' +
      `supported, permanent state; painting it red is absence-as-emptiness wearing a billing hat. ${seen}`)
  assert.equal(entitlement.tier, 'community', `the free build reports tier ${JSON.stringify(entitlement.tier)}`)
  assert.equal(entitlement.licensed, false, `the free build reports itself LICENSED. ${seen}`)
  assert.equal(entitlement.unlicensedInstall, 'full-function',
    `the free build no longer declares itself full-function: ${JSON.stringify(entitlement.unlicensedInstall)}`)
  assert.deepEqual(entitlement.gatedCapabilities, [],
    'the free build claims to gate something. Nothing in this payload is reserved for a paying ' +
      `customer. ${seen}`)
})

test('E1 ABSENCE FIRST -- no licence record is a complete answer, not a missing one', (t) => {
  const install = freshInstall(t)
  assert.equal(existsSync(path.join(install, 'config', 'entitlement.profile.json')), false,
    'a staged payload must not carry a licence record; that is per-installation customer data')

  const entitlement = entitlementOf(install)
  assert.equal(entitlement.licenseChecked, false,
    'the free build claims it checked a licence. It ships no code that could.')
  assert.equal(entitlement.licenseId, null)
  assert.equal(entitlement.expiresAt, null,
    'the free build reports an expiry. Nothing here expires.')
  assert.equal(typeof entitlement.unlicensedInstallStatement, 'string')
  assert.ok(entitlement.unlicensedInstallStatement.length > 40,
    'the unlicensed statement is what a customer is shown when they ask what free means; an ' +
      'empty string there is the absence-as-emptiness defect at the surface that matters most')
})

test('E2 ABSENCE FIRST -- a licence record the customer wrote themselves buys nothing', (t) => {
  const install = freshInstall(t)
  const before = entitlementOf(install)

  // config/entitlement.profile.json is the exact path src/lib/entitlement.js
  // reads an installed licence from. This is the whole fresh-install self-mint
  // attack as a customer can perform it against these bytes: assert an
  // entitlement, in the place the product would look for one.
  mkdirSync(path.join(install, 'config'), { recursive: true })
  writeFileSync(
    path.join(install, 'config', 'entitlement.profile.json'),
    `${JSON.stringify({
      licenseKey: 'self-minted.by.the.customer',
      product: 'toolsenabled.team.v1',
      tier: 'team',
      licensed: true,
      activatedAt: '2026-08-11T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z'
    }, null, 2)}\n`
  )

  const after = entitlementOf(install)
  assert.equal(after.tier, 'community',
    `a customer-written licence record moved this install to tier ${JSON.stringify(after.tier)}. ` +
      'A file the customer can write is not evidence of a purchase.')
  assert.equal(after.licensed, false)
  assert.deepEqual(after, before,
    'a customer-written licence record CHANGED the entitlement report. It must be inert: this ' +
      'build has no verifier, so anything it believed here it would be believing on the ' +
      'customer\'s word.')
})

/* ---------- F. the attack, attempted rather than argued about ---------- */

test('F1 the self-mint attack has nothing to mint with', (t) => {
  const install = freshInstall(t)
  for (const module of LICENSING_MODULES.concat(ADMISSION_MODULE)) {
    const outcome = loadFromInstall(install, module)
    assert.equal(outcome, 'MODULE_NOT_FOUND',
      `require('${module}') from a fresh install reported ${outcome}. A customer build that can ` +
        'load the issuer can sign its own licence; one that can load the admission check can ' +
        'answer its own request for admission.')
  }
})

test('F2 lying to the local report buys nothing, because the payload enforces nothing', (t) => {
  const install = freshInstall(t)

  // The strongest local attack available: the seam's own public API, used to
  // register a hostile reporter that claims the top paid tier. Anyone running
  // code on their own machine can do this, and it is not the vulnerability --
  // the vulnerability would be a payload that ACTS on the answer.
  const script =
    'const seam = require(' + JSON.stringify(path.join(install, 'src', 'lib', 'entitlement-report.js')) + ');' +
    "seam.registerEntitlementReporter('attacker', () => ({ ok: true, tier: 'team', licensed: true," +
    " active: true, gatedCapabilities: ['hosted-relay'] }));" +
    'const status = require(' + JSON.stringify(path.join(install, 'src', 'lib', 'system-status.js')) + ');' +
    'process.stdout.write(JSON.stringify(status.doctor().entitlement));'
  const lied = JSON.parse(execFileSync(process.execPath, ['-e', script], {
    cwd: install, encoding: 'utf8', windowsHide: true, timeout: 120000
  }))

  // Half one: the local report is NOT an authority, and this proves it can be
  // moved. If this assertion ever fails because the seam refuses a reporter, the
  // conclusion below still holds -- but the reader should know which world they
  // are in, so it is asserted rather than assumed.
  assert.equal(lied.tier, 'team',
    'the local diagnostic could not be moved by a locally registered reporter. That is not a ' +
      'failure of the product, but this test is written on the assumption that it can be, and an ' +
      'assumption that has quietly stopped holding is how a suite starts proving nothing.')

  // Half two, which is the one that matters: the payload has no gated capability
  // to open with that claim. The only licence-gated capability this product has
  // is the hosted relay, and the code that admits a connection to it is not here.
  const admission = loadFromInstall(install, ADMISSION_MODULE)
  assert.equal(admission, 'MODULE_NOT_FOUND',
    'a customer install that can be told it is entitled AND holds the admission check is a ' +
      'licence check on the honour system. The refusal must stay on the vendor\'s machine.')
})

/* ---------- G. the fence that keeps it this way ---------- */

test('G exactly one staged file consumes the entitlement seam, and it is the diagnostic', () => {
  assert.ok(PAYLOAD_ROOTS.length > 0, 'no payload root exists in this checkout')
  const seamRequire = /require\(\s*['"][^'"]*entitlement-report['"]\s*\)/

  for (const root of PAYLOAD_ROOTS) {
    const consumers = walk(root)
      .filter((file) => file.relative.endsWith('.js'))
      .filter((file) => seamRequire.test(readFileSync(file.absolute, 'utf8')))
      .map((file) => file.relative)
      .sort()

    assert.deepEqual(consumers, ['src/lib/system-status.js'],
      `${root} has ${consumers.length} consumer(s) of the entitlement seam: ${consumers.join(', ')}. ` +
        'The seam answers a DIAGNOSTIC question. A second consumer is almost certainly an access ' +
        'decision, and an access decision made from a locally registered reporter is a licence ' +
        'check a customer can answer for themselves (see F2). If a local pre-flight is genuinely ' +
        'wanted -- src/lib/anywhere-transport.js is the written one, and it requires ' +
        'src/lib/entitlement.js directly -- shipping it stages the tier table and the issuer, and ' +
        'the boundary guard will go red. Route it through the seam instead of widening the ' +
        'boundary.')
  }
})
