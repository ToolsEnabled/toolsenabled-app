#!/usr/bin/env node

// Discovery guard for the browser-proof drivers under tools/test/fixtures/.
//
// WHAT IT IS FOR, MEASURED 2026-09-10 (B1-12 / B1-13, ledger T58). Forty-three
// tools/test/fixtures/run-*.mjs drivers paint the product in a real browser
// and judge what they see -- the only proof for facts a DOM stand-in cannot
// supply. Thirty-eight of them were named by no suite, no tool and no package
// script, and the other five only in prose. tools/check-drivers-discovered.mjs
// never sees any of them: it skips tools/test/ by construction, and its
// DRIVER_SHAPED_NAME does not match the run- prefix. So the question "does a
// gate run the styled-buttons proof?" had the answer "no, and nothing reports
// that": a regression deleting the :where(button:not([class])) rule in
// src/styles.css would have turned no gate red.
//
// THE RULE
//
//   Every tools/test/fixtures/run-*.mjs must be declared in
//   tools/test/fixtures/browser-proofs.json as exactly one of
//     required          a release qualification must verify an attributable
//                       receipt from one real execution, or it is red;
//     manual            hand-run by a named owner or document; reported as
//                       discovered and unexecuted, never counted;
//     platform-limited  runnable only on the named platform; reported as
//                       discovered and unexecuted, never counted.
//   A driver with no declaration fails this guard, by name. A declaration whose
//   file is gone fails it as stale. DECLARATION IS NOT EXECUTION, and every line
//   this guard prints says which of the two it is reporting.
//
// WHAT "ATTRIBUTABLE" MEANS FOR A REQUIRED RECEIPT. The receipt must record the
// driver's own file name and sha256, and that sha256 must equal the bytes of
// the driver in THIS tree; it must name a loopback origin and the platform it
// ran on; its errors list must be empty, its checks list nonempty and its
// outside-request count zero. A receipt from another tree's driver is reported
// unattributable, not accepted: the proof has to bind to the source being
// qualified or it proves nothing about it.
//
// USAGE
//   node tools/check-browser-proofs-discovered.mjs                  discovery only
//   node tools/check-browser-proofs-discovered.mjs --receipts DIR   discovery, then
//        verify every required proof's receipt at DIR/<driver stem>/<receipt>
//   --quiet   only the failures
//
// Exit 0 every driver is declared (and, with --receipts, every required proof
// is executed and attributable) · 1 a finding · 2 the guard could not run.

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const FIXTURES_DIRECTORY = path.join(REPO_ROOT, 'tools', 'test', 'fixtures')
export const REGISTRY_FILE = path.join(FIXTURES_DIRECTORY, 'browser-proofs.json')
export const DEFAULT_RECEIPTS_DIRECTORY = 'private/browser-proof-receipts'

/* The name family. Deliberately the whole run- prefix rather than a list, so a
   driver added tomorrow is seen the day it lands. */
export const PROOF_SHAPED_NAME = /^run-[a-z0-9][a-z0-9-]*\.mjs$/

export const COVERAGE_CLASSES = Object.freeze(['required', 'manual', 'platform-limited'])
export const PLATFORMS = Object.freeze(['linux', 'win32', 'darwin'])
const RECEIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/
const LOOPBACK_ORIGIN = /^http:\/\/127\.0\.0\.1:\d{1,5}$/
const RECEIPT_LIMIT = 4 * 1024 * 1024

const posix = value => value.split(path.sep).join('/')
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

function guardError(message) {
  const error = new Error(message)
  error.code = 'BROWSER_PROOF_GUARD_CANNOT_RUN'
  return error
}

/* Read and shape-check the registry. Structural nonsense (not JSON, wrong
   schema) throws: the guard cannot run. A wrong declaration is a finding and is
   returned in `invalid`, so the report names it instead of stopping at it. */
export function loadBrowserProofRegistry(file = REGISTRY_FILE) {
  let registry
  try {
    registry = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw guardError(`cannot read the browser-proof registry ${posix(path.relative(REPO_ROOT, file))} (${error.code ?? error.message})`)
  }
  if (!registry || typeof registry !== 'object' || Array.isArray(registry) || registry.schemaVersion !== 1 ||
      !registry.proofs || typeof registry.proofs !== 'object' || Array.isArray(registry.proofs)) {
    throw guardError('the browser-proof registry must be a schemaVersion 1 object with a proofs map')
  }
  const families = registry.families && typeof registry.families === 'object' && !Array.isArray(registry.families) ? registry.families : {}
  const entries = new Map()
  const invalid = []
  for (const [name, raw] of Object.entries(registry.proofs)) {
    const problems = []
    if (!PROOF_SHAPED_NAME.test(name)) problems.push('its key is not a run-*.mjs driver name')
    const entry = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    if (raw !== entry) problems.push('its declaration is not an object')
    const family = entry.family === undefined ? null : entry.family
    if (family !== null && (typeof family !== 'string' || !Object.hasOwn(families, family))) problems.push(`it names an undeclared family ${JSON.stringify(family)}`)
    const inherited = family !== null && Object.hasOwn(families, family) ? families[family] : {}
    const reason = typeof entry.reason === 'string' ? entry.reason : inherited?.reason
    if (typeof reason !== 'string' || !reason.trim()) problems.push('it carries no written reason')
    if (!COVERAGE_CLASSES.includes(entry.coverage)) problems.push(`its coverage ${JSON.stringify(entry.coverage)} is not one of ${COVERAGE_CLASSES.join(', ')}`)
    if (entry.coverage === 'required') {
      if (typeof entry.receipt !== 'string' || !RECEIPT_NAME.test(entry.receipt)) problems.push('a required proof must name its receipt file')
      if (typeof entry.ledger !== 'string' || !entry.ledger.trim()) problems.push('a required proof must name the ledger item it discharges')
    }
    if (entry.coverage === 'platform-limited' && !PLATFORMS.includes(entry.platform)) problems.push(`a platform-limited proof must name one of ${PLATFORMS.join(', ')}`)
    if (problems.length) invalid.push({ name, problems })
    entries.set(name, { name, coverage: entry.coverage, reason, family, receipt: entry.receipt ?? null, ledger: entry.ledger ?? null,
      platform: entry.platform ?? null, owner: typeof entry.owner === 'string' ? entry.owner : inherited?.owner ?? null })
  }
  const receiptsDirectory = typeof registry.receiptsDirectory === 'string' && registry.receiptsDirectory ? registry.receiptsDirectory : DEFAULT_RECEIPTS_DIRECTORY
  return { file, entries, invalid, receiptsDirectory }
}

function discoverDrivers(directory) {
  let names
  try {
    names = readdirSync(directory, { withFileTypes: true })
  } catch (error) {
    throw guardError(`cannot read ${posix(path.relative(REPO_ROOT, directory) || directory)} (${error.code ?? error.message})`)
  }
  const discovered = []
  const linked = []
  for (const entry of names) {
    if (!PROOF_SHAPED_NAME.test(entry.name)) continue
    if (entry.isSymbolicLink()) { linked.push(entry.name); continue }
    if (entry.isFile()) discovered.push(entry.name)
  }
  return { discovered: discovered.sort(), linked: linked.sort() }
}

/* The whole finding, as data, so the tests exercise the decision instead of
   parsing console output. */
export function auditBrowserProofs(fixturesDirectory = FIXTURES_DIRECTORY, registryFile = path.join(fixturesDirectory, 'browser-proofs.json')) {
  fixturesDirectory = path.resolve(fixturesDirectory)
  const { discovered, linked } = discoverDrivers(fixturesDirectory)
  const loaded = loadBrowserProofRegistry(registryFile)
  const unregistered = discovered.filter(name => !loaded.entries.has(name))
  const stale = [...loaded.entries.keys()].filter(name => !discovered.includes(name)).sort()
  const entries = [...loaded.entries.values()].filter(entry => discovered.includes(entry.name)).sort((a, b) => a.name.localeCompare(b.name))
  const counts = { required: 0, manual: 0, platformLimited: 0 }
  for (const entry of entries) {
    if (entry.coverage === 'required') counts.required += 1
    else if (entry.coverage === 'manual') counts.manual += 1
    else if (entry.coverage === 'platform-limited') counts.platformLimited += 1
  }
  return { fixturesDirectory, registryFile: loaded.file, receiptsDirectory: loaded.receiptsDirectory, discovered, linked, entries,
    unregistered, stale, invalid: loaded.invalid, counts }
}

function readReceipt(file) {
  const stat = lstatSync(file)
  if (stat.isSymbolicLink() || !stat.isFile()) return { problem: 'the receipt is not a regular file' }
  if (stat.size <= 0 || stat.size > RECEIPT_LIMIT) return { problem: 'the receipt is empty or exceeds its byte budget' }
  const bytes = readFileSync(file)
  let receipt
  try { receipt = JSON.parse(bytes.toString('utf8')) } catch { return { problem: 'the receipt is not JSON' } }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return { problem: 'the receipt is not an object' }
  return { receipt, sha256: sha256(bytes), bytes: bytes.length }
}

/* One required proof, judged from its receipt. Never a skip: absence is the
   failure this whole guard exists to stop from reading as a pass. */
export function inspectBrowserProofReceipt(entry, { fixturesDirectory, receiptsDirectory }) {
  const driverFile = path.join(fixturesDirectory, entry.name)
  const stem = entry.name.replace(/\.mjs$/, '')
  const receiptFile = path.join(receiptsDirectory, stem, entry.receipt)
  const relative = value => posix(path.isAbsolute(value) && !path.relative(REPO_ROOT, value).startsWith('..') ? path.relative(REPO_ROOT, value) : value)
  const base = { name: entry.name, coverage: 'required', ledger: entry.ledger, receiptFile: relative(receiptFile) }
  const result = (kind, status, detail, extra = {}) => ({ ...base, kind, status, detail, ...extra })
  if (!existsSync(receiptFile)) return result('missing-required-browser-proof', 'unexecuted', `no receipt at ${relative(receiptFile)}`)
  const read = readReceipt(receiptFile)
  if (read.problem) return result('unreadable-browser-proof-receipt', 'unexecuted', read.problem)
  const { receipt } = read
  let driverSha256
  try { driverSha256 = sha256(readFileSync(driverFile)) } catch { return result('unattributable-browser-proof', 'unexecuted', 'the driver named by this proof cannot be read from this tree') }
  const identity = receipt.driver && typeof receipt.driver === 'object' ? receipt.driver : null
  if (!identity || typeof identity.sha256 !== 'string') return result('unattributable-browser-proof', 'unexecuted', 'the receipt records no driver identity (file and sha256)')
  if (identity.file !== `tools/test/fixtures/${entry.name}`) return result('unattributable-browser-proof', 'unexecuted', `the receipt names driver ${JSON.stringify(identity.file)}, not ${entry.name}`)
  if (identity.sha256 !== driverSha256) return result('unattributable-browser-proof', 'unexecuted', 'the receipt driver sha256 differs from the driver bytes in this tree')
  if (!PLATFORMS.includes(receipt.platform)) return result('unattributable-browser-proof', 'unexecuted', 'the receipt records no platform')
  if (typeof receipt.origin !== 'string' || !LOOPBACK_ORIGIN.test(receipt.origin)) return result('unattributable-browser-proof', 'unexecuted', 'the receipt origin is not a loopback server')
  if (!Array.isArray(receipt.errors) || !Array.isArray(receipt.checks)) return result('unreadable-browser-proof-receipt', 'unexecuted', 'the receipt carries no errors/checks lists')
  if (receipt.errors.length) return result('failed-browser-proof', 'failed', `${receipt.errors.length} error(s), first: ${String(receipt.errors[0]).slice(0, 160)}`)
  if (!receipt.checks.length) return result('failed-browser-proof', 'failed', 'the receipt records zero checks')
  if (receipt.outsideRequests !== undefined && receipt.outsideRequests !== 0) return result('failed-browser-proof', 'failed', `${receipt.outsideRequests} request(s) left the loopback origin`)
  return result('observed-pass', 'executed', `${receipt.checks.length} check(s), 0 errors`,
    { receiptSha256: read.sha256, driverSha256, platform: receipt.platform, checks: receipt.checks.length })
}

export function verifyBrowserProofReceipts(audit, receiptsDirectory) {
  receiptsDirectory = path.resolve(receiptsDirectory)
  const required = audit.entries.filter(entry => entry.coverage === 'required')
    .map(entry => inspectBrowserProofReceipt(entry, { fixturesDirectory: audit.fixturesDirectory, receiptsDirectory }))
  const unexecuted = audit.entries.filter(entry => entry.coverage !== 'required').map(entry => ({
    name: entry.name, coverage: entry.coverage, status: 'unexecuted',
    kind: entry.coverage === 'manual' ? 'manual-browser-proof' : 'platform-limited-browser-proof',
    ...(entry.platform ? { platform: entry.platform } : {}), reason: entry.reason,
  }))
  return { receiptsDirectory, required, unexecuted, obligations: required.filter(row => row.status !== 'executed') }
}

export function censusLine(audit) {
  return `Browser proofs: ${audit.discovered.length} driver(s) discovered under tools/test/fixtures/; ` +
    `${audit.counts.required} required, ${audit.counts.manual} manual, ${audit.counts.platformLimited} platform-limited; ` +
    `${audit.unregistered.length} unregistered, ${audit.stale.length} stale.`
}

function main() {
  const argv = process.argv.slice(2)
  const quiet = argv.includes('--quiet')
  const receiptsIndex = argv.indexOf('--receipts')
  if (receiptsIndex !== -1 && !argv[receiptsIndex + 1]) throw guardError('--receipts needs a directory')
  const receiptsDirectory = receiptsIndex === -1 ? null : path.resolve(REPO_ROOT, argv[receiptsIndex + 1])

  const audit = auditBrowserProofs()
  if (audit.discovered.length === 0) {
    console.error('Browser-proof discovery guard: ZERO run-*.mjs drivers exist under tools/test/fixtures/.')
    console.error('  A gate that discovered nothing reports success; this one does not.')
    process.exitCode = 1
    return
  }
  if (!quiet) console.log(censusLine(audit))

  let failed = false
  if (audit.unregistered.length) {
    failed = true
    console.error(`\n${audit.unregistered.length} browser-proof driver(s) exist and are declared NOWHERE in tools/test/fixtures/browser-proofs.json:`)
    for (const name of audit.unregistered) console.error(`  tools/test/fixtures/${name}`)
    console.error('\nDeclare each one as required (with its receipt and ledger item), manual (with its owner or document) or\n' +
      'platform-limited (with its platform), and write the reason. A driver that exists and is never run is\n' +
      'indistinguishable from one that passes; a declaration at least says which of the two it is.')
  }
  if (audit.linked.length) {
    failed = true
    console.error(`\n${audit.linked.length} run-*.mjs entr(ies) under tools/test/fixtures/ are links, which this guard does not follow:`)
    for (const name of audit.linked) console.error(`  ${name}`)
  }
  if (audit.stale.length) {
    failed = true
    console.error(`\n${audit.stale.length} declaration(s) name a driver that is not on disk:`)
    for (const name of audit.stale) console.error(`  ${name}`)
    console.error('  A declaration for a file nobody can find is a reason nobody can act on.')
  }
  if (audit.invalid.length) {
    failed = true
    console.error(`\n${audit.invalid.length} declaration(s) are malformed:`)
    for (const { name, problems } of audit.invalid) for (const problem of problems) console.error(`  ${name} -- ${problem}`)
  }

  if (receiptsDirectory === null) {
    if (!failed && !quiet) {
      console.log('Every browser-proof driver is declared in writing; discovered is not executed: ' +
        `${audit.counts.required} required proof(s) unverified (no receipts directory), ` +
        `${audit.counts.manual} manual and ${audit.counts.platformLimited} platform-limited proof(s) unexecuted by declaration.`)
    }
    if (failed) process.exitCode = 1
    return
  }

  const verified = verifyBrowserProofReceipts(audit, receiptsDirectory)
  for (const row of verified.required) {
    if (row.status === 'executed') {
      if (!quiet) console.log(`Required proof ${row.name}: observed-pass; receipt ${row.receiptFile} sha256 ${row.receiptSha256}; driver sha256 ${row.driverSha256}; platform ${row.platform}.`)
    } else {
      failed = true
      console.error(`not ok - Required proof ${row.name}: ${row.kind} -- ${row.detail}`)
    }
  }
  if (failed) {
    console.error('\nA required browser proof without an attributable passing receipt is a failure, not a skip.\n' +
      `Run the driver against this exact tree and place its receipt under ${posix(path.relative(REPO_ROOT, receiptsDirectory) || receiptsDirectory)}/<driver stem>/.`)
    /* The verdict and the code on one line, so a shell that does not surface
       a native exit status (Windows PowerShell 5.1's $? is true after any
       native command; a pipeline's $? is the LAST command's, e.g. grep) cannot
       be read as green. */
    console.error('browser-proof qualification: RED -- exit 1')
    process.exitCode = 1
    return
  }
  if (!quiet) {
    console.log(`Every required browser proof is executed and attributable; ${audit.counts.manual} manual and ` +
      `${audit.counts.platformLimited} platform-limited proof(s) are declared, discovered and unexecuted.`)
    /* On stderr, like the RED line: stdout is the report the cut's source-suites
       adapter parses, and it must contain only the census and its completion. */
    console.error('browser-proof qualification: GREEN -- exit 0')
  }
}

/* argv can name this file through a symlink or a redundantly spelled path.
   Compare filesystem identities so main() cannot be skipped by spelling. */
const invokedFile = process.argv[1]
let isMainModule = false
if (invokedFile) {
  try {
    isMainModule = realpathSync.native(invokedFile) === realpathSync.native(fileURLToPath(import.meta.url))
  } catch { /* an argv path that cannot be resolved is not this module */ }
}

if (isMainModule) {
  try {
    main()
  } catch (error) {
    console.error(`Browser-proof discovery guard error: ${error?.message ?? error}`)
    process.exitCode = 2
  }
}
