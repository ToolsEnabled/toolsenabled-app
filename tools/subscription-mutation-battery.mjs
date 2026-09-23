#!/usr/bin/env node

/* CAN EACH OF THESE CONTROLS ACTUALLY GO RED?
 *
 * A green suite proves nothing on its own -- roughly fifteen defects shipped
 * past green in this repository this sprint. So every rule the subscription
 * work claims to enforce gets a deliberate defect planted under it, and the
 * suite has to notice. A mutation that survives is a rule with no test.
 *
 * Each mutation:
 *   1. records the target file's sha256,
 *   2. applies one surgical edit and CONFIRMS the plant landed (sha changed),
 *   3. runs the suite that is supposed to catch it, bare exit code read
 *      directly from the child process and never through a pipe,
 *   4. restores the file and CONFIRMS the restore is byte-identical.
 *
 * One mutation is a data mutation rather than a code one: rule 1 of the claims
 * guard compares the SHIPPED catalog against the model, and the honest way to
 * test that is to change the shipped price -- which is exactly the real-world
 * failure it exists for (someone edits the generated file by hand).
 *
 * Exit 0 only when every mutation was killed and every restore was exact.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = process.env.TOOLSENABLED_SOURCE

const CLAIMS = 'tools/check-subscription-claims.mjs'
const GEN = 'tools/gen-subscription-catalog.mjs'
const READER = 'src/subscription-catalog.js'
const FLOW = 'src/subscription-signup.js'
/* The service moved to shell/ so it would actually SHIP -- build.files excludes
   tools/**, so while it lived there the packaged app had a subscription page and
   no endpoint behind it. The mutations below are anchored on its code rather
   than on its path, so they all still apply; only this line changed. */
const SERVICE = 'shell/subscribe-service.cjs'
/* The generated catalog moved out of the renderer payload for R1214: everything
   under public/ is copied into dist/ and packed into app.asar, so a price list
   authored there shipped by default. M26 -- a hand-edited price in the committed
   file -- is the mutation that once survived a broken rule 1, so it still points
   at wherever that file really is. */
const CATALOG = 'config/subscription-catalog.json'

const SUITE_CATALOG = 'tools/test/subscription-catalog.test.mjs'
const SUITE_FLOW = 'tools/test/subscription-signup.test.mjs'
const SUITE_SERVICE = 'tools/test/subscribe-service.test.mjs'

/** [id, file, find, replace, detector] -- detector is a suite path or 'GUARD'. */
const MUTATIONS = [
  ['M1 rule 2 never reports an unbacked promise', CLAIMS,
    'const violations = []\n  for (const promise of promises) {',
    'const violations = []\n  if (promises) return violations\n  for (const promise of promises) {', SUITE_CATALOG],

  /* The mutation that reproduces the defect this battery actually found: rule
     1's comparison used JSON.stringify's replacer-ARRAY argument as if it were
     a sort order, which silently dropped every nested value and made any two
     catalogs compare equal. It shipped green and was only caught because M26 --
     a hand-edited price in the shipped file -- SURVIVED. Re-planting it here so
     the same mistake cannot come back unnoticed. */
  ['M1b rule 1 stops comparing the shipped catalog with the model', CLAIMS,
    'return JSON.stringify(canonical(rest))',
    'return JSON.stringify(canonical(rest), Object.keys(rest).sort())', SUITE_CATALOG],

  ['M2 rule 3 stops looking for a restated price', CLAIMS,
    "    const pattern = new RegExp(`(^|[^\\\\w.])${value}([^\\\\w.]|$)`)",
    "    const pattern = new RegExp('(?!)')", SUITE_CATALOG],

  ['M3 a missing promise register reads as an empty one', CLAIMS,
    "  if (!existsSync(file)) {\n    throw new Error(",
    "  if (!existsSync(file)) {\n    return { promises: [] }\n  }\n  if (false) {\n    throw new Error(", SUITE_CATALOG],

  ['M4 a promise with no provenance is accepted', CLAIMS,
    "    if (typeof promise.provenance !== 'string' || !promise.provenance.trim()) {",
    "    if (false) {", SUITE_CATALOG],

  ['M5 a tier may grant a capability the model never declared', GEN,
    '      if (!capabilities[id]) {\n        throw new Error(',
    '      if (false) {\n        throw new Error(', SUITE_CATALOG],

  ['M6 a paid plan with no price is emitted anyway', GEN,
    '    if (plan.monthlyUsd === null) {\n      throw new Error(',
    '    if (false) {\n      throw new Error(', SUITE_CATALOG],

  ['M7 the free-forever list stops being required', GEN,
    "  if (!Array.isArray(entitlement?.NEVER_GATED) || entitlement.NEVER_GATED.length === 0) {",
    "  if (false) {", SUITE_CATALOG],

  ['M8 the browser reader accepts an unrecognised schema version', READER,
    '  if (data.schemaVersion !== SCHEMA_VERSION) {',
    '  if (false) {', SUITE_CATALOG],

  ['M9 the browser reader accepts a paid plan with no price', READER,
    '      if (!Number.isFinite(plan.monthlyUsd) || plan.monthlyUsd <= 0) {',
    '      if (false) {', SUITE_CATALOG],

  ['M10 an unknown service state is treated as a good one', FLOW,
    "    const named = typeof reply.state === 'string' && SERVICE_STATES.has(reply.state) ? reply.state : null",
    "    const named = typeof reply.state === 'string' ? reply.state : null", SUITE_FLOW],

  ['M11 a success with no payment link counts as checkout', FLOW,
    "      if (reply.state !== 'checkout' || typeof reply.checkoutUrl !== 'string' || !reply.checkoutUrl) {",
    "      if (false) {", SUITE_FLOW],

  ['M12 the double press is allowed through', FLOW,
    '      if (inFlight) return snapshot()',
    '      if (false) return snapshot()', SUITE_FLOW],

  ['M13 an edited field keeps the previous attempt key', FLOW,
    '  function startNewAttempt() { attemptKey = null }',
    '  function startNewAttempt() { /* keep the key */ }', SUITE_FLOW],

  ['M14 the restored page never re-enables the form', FLOW,
    '    restored() {\n      inFlight = false',
    '    restored() {\n      inFlight = inFlight', SUITE_FLOW],

  ['M15 an offline device sends the request anyway', FLOW,
    '      if (!online()) {',
    '      if (false) {', SUITE_FLOW],

  ['M16 an unset provider mode is accepted', SERVICE,
    "  if (mode !== 'test') {",
    "  if (false) {", SUITE_SERVICE],

  ['M17 a live secret key is accepted', SERVICE,
    '  if (LIVE_SECRET.test(secretKey)) {',
    '  if (false) {', SUITE_SERVICE],

  ['M18 a live-mode session is handed to the customer', SERVICE,
    "      if (!reply.id.startsWith('cs_test_')) {",
    '      if (false) {', SUITE_SERVICE],

  ['M19 an existing active subscriber is sold a second subscription', SERVICE,
    "      if (account.state === 'active') {",
    '      if (false) {', SUITE_SERVICE],

  ['M20 an unreadable account record is treated as a new customer', SERVICE,
    "  return { state: 'unreadable' }",
    "  return { state: 'new' }", SUITE_SERVICE],

  ['M21 the same attempt key creates a second checkout session', SERVICE,
    '      const previous = state.attempts[idempotencyKey]\n      if (previous) {',
    '      const previous = state.attempts[idempotencyKey]\n      if (false) {', SUITE_SERVICE],

  ['M22 a corrupt ledger is silently replaced with an empty one', SERVICE,
    "      throw new SignupRefusal('unavailable',\n        'the signup ledger is not valid JSON; refusing to overwrite it. No signup can be recorded until a '\n        + 'human looks at it.', { status: 503 })",
    '      return { schemaVersion: 1, accounts: {}, attempts: {}, signups: {} }', SUITE_SERVICE],

  ['M23 a missing price map becomes an empty one', SERVICE,
    '  if (!existsSync(file)) {\n    throw new SignupRefusal(',
    '  if (false) {\n    throw new SignupRefusal(', SUITE_SERVICE],

  ['M24 a price map marked live is loaded', SERVICE,
    "  if (parsed.mode !== 'test') {",
    '  if (false) {', SUITE_SERVICE],

  ['M25 the required fulfilment metadata may be empty', SERVICE,
    "  if (!engine?.TIERS || !engine?.REQUIRED_METADATA) {",
    '  if (false) {', SUITE_SERVICE],
]

const sha = file => createHash('sha256').update(readFileSync(path.join(REPO_ROOT, file))).digest('hex').toUpperCase()

function runSuite(suite) {
  const result = spawnSync(process.execPath, ['--test', suite], {
    cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, ...(SOURCE ? { TOOLSENABLED_SOURCE: SOURCE } : {}) },
  })
  const failing = [...(result.stdout || '').matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1])
  return { code: result.status, failing }
}

function runGuard() {
  const result = spawnSync(process.execPath, [CLAIMS], {
    cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, ...(SOURCE ? { TOOLSENABLED_SOURCE: SOURCE } : {}) },
  })
  return { code: result.status, out: `${result.stdout}${result.stderr}` }
}

let killed = 0
const survivors = []

console.log('BASELINE')
for (const file of [CLAIMS, GEN, READER, FLOW, SERVICE]) console.log(`  ${file} ${sha(file).slice(0, 16)}`)
for (const suite of [SUITE_CATALOG, SUITE_FLOW, SUITE_SERVICE]) {
  const { code } = runSuite(suite)
  console.log(`  ${suite} bare exit ${code}`)
  if (code !== 0) { console.error('the baseline is not green; a mutation battery on a red baseline proves nothing.'); process.exit(2) }
}

console.log('\nMUTATIONS')
for (const [id, file, find, replace, suite] of MUTATIONS) {
  const absolute = path.join(REPO_ROOT, file)
  const original = readFileSync(absolute, 'utf8')
  const before = sha(file)
  if (!original.includes(find)) {
    survivors.push(`${id} -- THE PLANT DID NOT APPLY: anchor text not found in ${file}`)
    console.log(`SKIP ${id} (anchor missing)`)
    continue
  }
  writeFileSync(absolute, original.replace(find, replace), 'utf8')
  const planted = sha(file)
  if (planted === before) {
    survivors.push(`${id} -- the plant produced a byte-identical file`)
    continue
  }
  const { code, failing } = runSuite(suite)
  writeFileSync(absolute, original, 'utf8')
  const restored = sha(file)
  if (restored !== before) { console.error(`RESTORE FAILED for ${file}`); process.exit(2) }

  if (code === 0) {
    survivors.push(`${id} -- SURVIVED: ${path.basename(suite)} stayed green with the defect in place`)
    console.log(`SURVIVED ${id}`)
  } else {
    killed += 1
    console.log(`killed   ${id} -> exit ${code}, ${failing.length} red :: ${failing[0] || '(unnamed)'}`)
  }
}

// --- the data mutation: rule 1, drift between the shipped catalog and the model
{
  const absolute = path.join(REPO_ROOT, CATALOG)
  const original = readFileSync(absolute, 'utf8')
  const catalog = JSON.parse(original)
  const paid = catalog.plans.find(plan => plan.requiresLicense)
  const baseline = runGuard()
  catalog.plans = catalog.plans.map(plan => (plan.id === paid.id ? { ...plan, monthlyUsd: plan.monthlyUsd + 10 } : plan))
  writeFileSync(absolute, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')
  const mutated = runGuard()
  writeFileSync(absolute, original, 'utf8')
  const restored = readFileSync(absolute, 'utf8')

  const noticed = mutated.out.includes('no longer matches the entitlement model') && !baseline.out.includes('no longer matches the entitlement model')
  if (restored !== original) { console.error('RESTORE FAILED for the catalog'); process.exit(2) }
  if (noticed) { killed += 1; console.log(`killed   M26 the shipped catalog is hand-edited to a different price -> rule 1 reported drift (exit ${mutated.code})`) }
  else { survivors.push('M26 -- SURVIVED: a hand-edited price in the shipped catalog was not reported as drift'); console.log('SURVIVED M26') }
}

const total = MUTATIONS.length + 1
console.log(`\n${killed}/${total} mutations killed`)
if (survivors.length) {
  console.error('\nSURVIVORS (each one is a rule with no test behind it):')
  for (const survivor of survivors) console.error(`  - ${survivor}`)
  process.exitCode = 1
} else {
  console.log('Every rule these controls claim to enforce is covered by a test that can actually go red.')
}
