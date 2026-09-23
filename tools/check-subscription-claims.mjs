#!/usr/bin/env node

/* A SUBSCRIPTION PAGE THAT PROMISES A CAPABILITY THE TIER DOES NOT GRANT IS A
 * LIE THE PRODUCT TELLS FOR MONEY. This is the program that refuses it.
 *
 * Four rules, each of which has a real failure behind it:
 *
 * RULE 1 -- THE COMMITTED CATALOG MUST STILL EQUAL THE MODEL.
 *   config/subscription-catalog.json is generated, but a generated file
 *   that is committed is just a hand-written file with a good story: it goes
 *   stale the moment the model changes and nothing re-runs the generator. This
 *   rule re-derives the catalog and compares. Drift is exit 1, not a warning,
 *   because the drifted value is a PRICE.
 *
 * RULE 2 -- EVERY OWNER-STATED INCLUSION MUST ACTUALLY BE GRANTED.
 *   config/subscription-promises.json records what the owner has said a paid
 *   tier includes. Each entry must correspond to a declared capability in
 *   GATED_CAPABILITIES whose requiredTiers admit every tier the register says
 *   it ships with. A promise nothing grants is the exact defect this lane was
 *   told to make impossible, and the honest place for it to surface is a red
 *   guard naming the missing declaration -- not a checkout page.
 *
 * RULE 3 -- THE PAGE MUST NOT CARRY ITS OWN COPY OF A PRICE.
 *   The renderer is checked for currency literals and for the model's own
 *   numbers written out. One hardcoded "$19" beside a catalog that says
 *   something else is how a customer reads one price and is charged another.
 *
 * RULE 4 -- THE LAUNCH SURFACE MUST CARRY NO PRICE LIST AT ALL.
 *   The catalog was authored at public/data/subscription-catalog.json, and
 *   everything under public/ ships: vite copies it into dist/ and build.files
 *   packs dist/**. So #/subscribe and #/pricing rendered a plan table -- a Team
 *   price and a three-seat minimum, generated 2026-08-12 -- inside an installer
 *   whose release rule is "we are NOT collecting payments at first public
 *   launch" (R1214). The fix is not a flag and not an emptied file: THE BYTES
 *   ARE NOT IN THE PAYLOAD, which is the answer src/checkout-visibility.js
 *   already records for the same defect one screen over. This rule refuses a
 *   file at the old path, and config/renderer-payload-boundary.json classifies
 *   it `withheld` so tools/check-renderer-payload.mjs -- which the dist chain
 *   really does run -- fails the packaged build on it too.
 *
 * ABSENCE IS TESTED FIRST AND FAILS CLOSED. A missing engine tree, a missing
 * catalog, a missing or unparseable promise register, a register with no
 * `promises` array -- every one of them is exit 2 (setup problem), never a
 * pass. A guard that goes green because it could not find what it was supposed
 * to check is this codebase's most-repeated defect wearing a billing hat.
 *
 * EXIT CODES, matching tools/check-no-owner-data.mjs and
 * tools/check-product-naming.mjs so a build script can chain them:
 *   0  every claim the page can make is backed by the model
 *   1  a claim is not backed, or the shipped catalog has drifted
 *   2  a setup problem -- nothing was checked
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildCatalog, loadEntitlement, resolveEngineRoot } from './gen-subscription-catalog.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CATALOG_FILE = path.join(REPO_ROOT, 'config', 'subscription-catalog.json')
const PROMISES_FILE = path.join(REPO_ROOT, 'config', 'subscription-promises.json')
/* Rule 4's subject. The catalog used to be authored HERE, inside the directory
 * vite copies into dist/ and electron-builder packs into app.asar, so the price
 * list shipped by default rather than by decision (R1214). Nothing writes this
 * path any more; this guard names it so that a file reappearing at it is a
 * refusal with a reason rather than a silent return of the price page. */
const PAYLOAD_CATALOG_FILE = path.join(REPO_ROOT, 'public', 'data', 'subscription-catalog.json')
const RENDERER_FILES = [
  path.join('src', 'views', 'subscribe.js'),
  path.join('src', 'subscription-signup.js')
]

/**
 * Everything except `generatedAt`, which is a clock reading and not a claim,
 * rendered so that two catalogs saying the same thing compare equal.
 *
 * THE BUG THIS FUNCTION USED TO HAVE, RECORDED BECAUSE IT IS AN EASY ONE TO
 * WRITE AGAIN. It was `JSON.stringify(rest, Object.keys(rest).sort())`. The
 * second argument to JSON.stringify is not a sort order -- it is a REPLACER
 * ARRAY, an allowlist of property names applied at EVERY level. So the output
 * contained only properties whose names happened to appear at the top level:
 * every price, plan id and capability label was silently dropped, and rule 1
 * compared two nearly-empty strings that were always equal. The guard reported
 * "catalog matches the model" while the shipped catalog said a different price.
 * It was found by tools/subscription-mutation-battery.mjs mutation M26 -- a
 * hand-edited price in the shipped file -- which survived. Ordering is handled
 * by `canonical` below, which really does sort every level.
 */
export function comparable(catalog) {
  const { generatedAt, ...rest } = catalog
  return JSON.stringify(canonical(rest))
}

/* Sorts every level, so a re-ordered model does not read as drift. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  }
  return value
}

export function readPromiseRegister(file = PROMISES_FILE) {
  if (!existsSync(file)) {
    throw new Error(
      `no promise register at ${path.relative(REPO_ROOT, file)}. Without it this guard cannot tell an ` +
      'unclaimed capability from an unrecorded promise, so it must not pass.'
    )
  }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`${path.relative(REPO_ROOT, file)} is not valid JSON: ${error.message}`)
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.promises)) {
    throw new Error(
      `${path.relative(REPO_ROOT, file)} has no "promises" array. An empty register is written as ` +
      '"promises": [] -- a MISSING one is indistinguishable from a truncated file and is refused.'
    )
  }
  for (const [index, promise] of parsed.promises.entries()) {
    if (!promise || typeof promise.capability !== 'string' || !promise.capability.trim()) {
      throw new Error(`promise #${index} names no capability.`)
    }
    if (!Array.isArray(promise.includedWithTiers) || promise.includedWithTiers.length === 0) {
      throw new Error(
        `promise "${promise.capability}" names no tiers it is included with. "Included" with nothing in ` +
        'particular is the vaguest possible form of a paid claim and is refused.'
      )
    }
    if (typeof promise.provenance !== 'string' || !promise.provenance.trim()) {
      throw new Error(
        `promise "${promise.capability}" carries no provenance. An unattributed promise cannot be ` +
        'distinguished from one an agent invented, and this codebase has already shipped one of those.'
      )
    }
  }
  return parsed
}

/**
 * Rule 2, as a pure function so the test suite can drive it against synthetic
 * models rather than only against the engine tree on this machine.
 * Returns the list of violations; empty means every promise is backed.
 */
export function unbackedPromises(promises, catalog) {
  const violations = []
  for (const promise of promises) {
    const capability = catalog.capabilities[promise.capability]
    if (!capability) {
      violations.push(
        `the owner stated that "${promise.capability}" is included with ${promise.includedWithTiers.join(' and ')}, ` +
        `but GATED_CAPABILITIES declares no such capability -- so no tier grants it, no gate enforces it, and the ` +
        `page has nothing true to render. Declare it in the engine's src/lib/entitlement.js (it is a CLOSED set: ` +
        `decide() throws on an id that is not in it) before any plan card can say so. Provenance: ${promise.provenance}`
      )
      continue
    }
    for (const tierId of promise.includedWithTiers) {
      const plan = catalog.plans.find(candidate => candidate.id === tierId)
      if (!plan) {
        violations.push(
          `promise "${promise.capability}" names tier "${tierId}", which the model does not declare.`
        )
        continue
      }
      if (!capability.requiredTiers.includes(tierId)) {
        violations.push(
          `"${promise.capability}" is promised with the ${plan.label} plan, but its requiredTiers are ` +
          `${capability.requiredTiers.join(', ')} -- ${plan.label} is not among them.`
        )
      }
      if (!plan.grants.includes(promise.capability)) {
        violations.push(
          `the ${plan.label} plan is promised "${promise.capability}" but its grants are ` +
          `${plan.grants.length ? plan.grants.join(', ') : '(nothing)'}. A plan that does not grant it does not ` +
          'include it, whatever the marketing says.'
        )
      }
    }
  }
  return violations
}

/**
 * Rule 3, pure. `numbers` are the model's own prices; finding one written out
 * in the renderer means a second copy exists that no generator maintains.
 */
export function hardcodedMoney(source, numbers) {
  const findings = []
  /* Strip line and block comments first. The renderer EXPLAINS why it has no
     prices of its own, and that explanation necessarily mentions money; a
     guard that fires on its own rationale gets deleted, and then rule 3
     protects nothing. Only executable text is searched. */
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
  if (/\$\s?\d/.test(code)) {
    findings.push('a currency literal ("$" followed by a digit) appears in executable code')
  }
  if (/\bUSD\b|\bpermonth\b/i.test(code) && /\d/.test(code)) {
    // narrow: a currency word next to a number, not the word alone
    if (/\b\d+(\.\d+)?\s*(USD|usd)\b|\b(USD|usd)\s*\d/.test(code)) {
      findings.push('a currency-qualified number appears in executable code')
    }
  }
  for (const value of numbers) {
    const pattern = new RegExp(`(^|[^\\w.])${value}([^\\w.]|$)`)
    if (pattern.test(code)) {
      findings.push(
        `the number ${value} -- which is one of the model's prices -- appears in executable code. ` +
        'It must be read from the catalog, not restated.'
      )
    }
  }
  return findings
}

function main() {
  const explicit = process.argv.includes('--source')
    ? process.argv[process.argv.indexOf('--source') + 1]
    : null

  // --- setup, all of it exit 2 on failure -------------------------------
  const { root, entitlement: entitlementPath } = resolveEngineRoot(explicit)
  const register = readPromiseRegister()
  if (!existsSync(CATALOG_FILE)) {
    throw new Error(
      `no ${path.relative(REPO_ROOT, CATALOG_FILE)}. Run: node tools/gen-subscription-catalog.mjs. ` +
      'A missing catalog is not an empty one -- the page fails closed on it, and so does this guard.'
    )
  }
  let shipped
  try {
    shipped = JSON.parse(readFileSync(CATALOG_FILE, 'utf8'))
  } catch (error) {
    throw new Error(`${path.relative(REPO_ROOT, CATALOG_FILE)} is not valid JSON: ${error.message}`)
  }
  for (const relative of RENDERER_FILES) {
    if (!existsSync(path.join(REPO_ROOT, relative))) {
      throw new Error(`renderer file is missing: ${relative}. Rule 3 has nothing to check, so nothing passes.`)
    }
  }

  const derived = buildCatalog(loadEntitlement(entitlementPath))
  const problems = []

  console.log(`Engine tree: ${root}`)
  console.log(`Paid product: ${derived.paidProduct}`)

  // --- rule 1: no drift --------------------------------------------------
  if (comparable(shipped) !== comparable(derived)) {
    problems.push(
      'the shipped subscription catalog no longer matches the entitlement model. Re-run ' +
      'node tools/gen-subscription-catalog.mjs and read the diff before committing it -- the values that ' +
      'differ are what a customer would have been shown while being charged something else.'
    )
  } else {
    console.log(`  rule 1 catalog matches the model (${derived.plans.length} plans, ` +
      `${Object.keys(derived.capabilities).length} gated capabilities)`)
  }

  // --- rule 2: every promise is backed -----------------------------------
  const violations = unbackedPromises(register.promises, derived)
  problems.push(...violations)
  if (violations.length === 0) {
    console.log(`  rule 2 all ${register.promises.length} recorded promises are granted by the model`)
  }

  // --- rule 3: no second copy of a price ---------------------------------
  const prices = [...new Set(derived.plans
    .flatMap(plan => [plan.monthlyUsd, plan.annualUsd])
    .filter(value => Number.isFinite(value) && value > 0))]
  let rule3Clean = true
  for (const relative of RENDERER_FILES) {
    const findings = hardcodedMoney(readFileSync(path.join(REPO_ROOT, relative), 'utf8'), prices)
    for (const finding of findings) {
      rule3Clean = false
      problems.push(`${relative}: ${finding}`)
    }
  }
  if (rule3Clean) console.log(`  rule 3 no renderer carries its own copy of a price`)

  // --- rule 4: the launch surface carries no price list ------------------
  if (existsSync(PAYLOAD_CATALOG_FILE)) {
    problems.push(
      `${path.relative(REPO_ROOT, PAYLOAD_CATALOG_FILE)} exists. Everything under public/ is copied into ` +
      'dist/ by vite and packed into app.asar by electron-builder, so this file is a price list in the ' +
      'installer. The owner\'s rule for the first public launch is that payments are not collected, and ' +
      'R1214 records that the catalog reaching #/subscribe and #/pricing was never authorised. Delete it; ' +
      'the generated catalog belongs at config/subscription-catalog.json, where this guard reads it.'
    )
  } else {
    console.log('  rule 4 the renderer payload carries no price catalog')
  }

  if (problems.length > 0) {
    console.error('\nThe subscription page would make a claim the entitlement model does not back:')
    for (const problem of problems) console.error(`  - ${problem}`)
    console.error(
      '\nThe page renders from the model, never from the promise register, so nothing above has reached a ' +
      'customer. Fix it in src/lib/entitlement.js (declare and grant the capability) or withdraw the promise ' +
      'from config/subscription-promises.json. Editing the page is not a fix and cannot become one.'
    )
    process.exitCode = 1
    return
  }
  console.log(`\nChecked ${register.promises.length} promises against ${derived.plans.length} plans. Every claim is backed.`)
}

/* Compare filesystem identities, not spellings. Release lanes invoke gates
 * through junctions (and Windows paths are case-insensitive); a spelling
 * comparison can therefore skip main and report success without checking
 * anything. Both operands exist when Node is executing this module, so a
 * realpath failure is correctly fatal rather than another blind pass. */
if (process.argv[1] &&
    realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url))) {
  try {
    main()
  } catch (error) {
    console.error(`Subscription claims guard error: ${error.message}`)
    process.exitCode = 2
  }
}
