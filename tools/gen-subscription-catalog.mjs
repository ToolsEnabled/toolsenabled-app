#!/usr/bin/env node

/* THE SUBSCRIPTION PAGE IS NOT ALLOWED TO KNOW ITS OWN PRICES.
 *
 * This generator is the only thing that writes config/subscription-catalog.json,
 * and it derives every word of it from the engine's src/lib/entitlement.js -- the
 * module that already declares, in one closed table, what is sold, what it costs,
 * and the complete set of capabilities a licence may gate.
 *
 * WHY A GENERATOR AND NOT A HAND-WRITTEN JSON. The page that takes someone's
 * money is the surface where a stale claim stops being a cosmetic defect and
 * becomes a lie told for payment. A hand-maintained plan table drifts from the
 * entitlement model exactly the way README.md drifted from it (see
 * tools/check-product-naming.mjs, which exists because that already happened
 * once, in public, on the documents a buyer reads). A second hand-maintained
 * copy on the checkout page would be the same defect at the worst possible
 * point on the funnel.
 *
 * WHAT IS DERIVED, AND WHAT IS DELIBERATELY REFUSED. Every inclusion line on
 * the page comes from GATED_CAPABILITIES[id] for an id listed in that tier's
 * `grants`. There is no free-text "what you get" field anywhere in the emitted
 * catalog and no place to add one: if a capability is not in the model's closed
 * table, the page has nothing to render for it, so the page CANNOT promise it.
 * That is the mechanical form of requirement (d) of this lane -- "every claim
 * about what a tier includes must be TRUE against the entitlement model".
 *
 * THE FREE SIDE IS CARRIED TOO, ON PURPOSE. UNLICENSED_INSTALL_STATEMENT and
 * NEVER_GATED are emitted alongside the plans because a pricing page that shows
 * only the paid column implies the free one is a trial. R1228/R1229 refuse that
 * reading and so does this catalog.
 *
 * EXIT CODES follow tools/check-no-owner-data.mjs and tools/check-product-naming.mjs
 * deliberately -- 0 wrote a catalog, 2 a setup problem. There is no exit 1 here:
 * this program either produces a catalog derived from the model or produces
 * nothing at all. A partially-derived catalog is the failure mode it exists to
 * prevent, so it is not a state this program can end in.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/* IT USED TO WRITE INTO public/data/, WHICH IS THE PAYLOAD, AND THAT IS THE
 * DEFECT R1214 NAMES. vite copies public/** into dist/ verbatim and
 * package.json build.files packs dist/**, so this one command was all it took
 * to put a price list -- a Team price and a three-seat minimum the owner never
 * authorised, generated 2026-08-12 -- into every installer. The owner's release
 * rule for the first public launch is "we are NOT collecting payments at first
 * public launch", so a program that can arm the launch surface by being run is
 * the wrong shape no matter what it writes.
 *
 * The catalog is still generated and still committed: tools/check-subscription-
 * claims.mjs rule 1 needs a file to compare against the model, and a drift check
 * with nothing to check is this codebase's most-repeated defect. It just does
 * not live in the payload any more. config/ is where the rest of the
 * subscription build inputs already are (config/subscription-promises.json,
 * config/subscription-prices.example.json), and build.files names exactly one
 * file out of config/ (google-signin.json), so nothing here can travel by
 * accident the way public/ made it travel by default. */
const OUTPUT_FILE = path.join(REPO_ROOT, 'config', 'subscription-catalog.json')
const SOURCE_SETTING_FILE = path.join(REPO_ROOT, 'private', 'capability-source.owner.json')

export const CATALOG_SCHEMA_VERSION = 1

/* Same precedence as tools/check-product-naming.mjs and
 * tools/pack-capability-layer.mjs. A build that stages the payload from one
 * engine tree must not price the product from another. */
export function resolveEngineRoot(explicit, { env = process.env } = {}) {
  let configured = null
  if (existsSync(SOURCE_SETTING_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(SOURCE_SETTING_FILE, 'utf8'))
      if (parsed && typeof parsed.path === 'string' && parsed.path.trim()) configured = parsed.path.trim()
    } catch (error) {
      throw new Error(`private/capability-source.owner.json is present but unreadable: ${error.message}`)
    }
  }
  const candidate = [explicit, env.TOOLSENABLED_SOURCE, configured].filter(Boolean)[0]
  if (!candidate) {
    throw new Error(
      'cannot find the capability-layer source tree, so the plans on the subscription page cannot be ' +
      'derived from the entitlement model. Set one of: --source <path>, TOOLSENABLED_SOURCE=<path>, ' +
      'or private/capability-source.owner.json. Refusing to emit a catalog nobody derived.'
    )
  }
  const resolved = path.resolve(candidate)
  const entitlement = path.join(resolved, 'src', 'lib', 'entitlement.js')
  if (!existsSync(entitlement)) {
    throw new Error(`no src/lib/entitlement.js under the configured capability source: ${resolved}`)
  }
  return { root: resolved, entitlement }
}

/* LOADED, NOT PARSED -- for the reason tools/check-product-naming.mjs states:
 * a regex asserts what the source text says, requiring the module asserts what
 * it actually exports, and only the second one is what a billing surface reads. */
export function loadEntitlement(entitlementPath) {
  const require_ = createRequire(import.meta.url)
  let module_
  try {
    module_ = require_(entitlementPath)
  } catch (error) {
    throw new Error(`could not load ${entitlementPath}: ${error.message}`)
  }
  for (const field of ['PAID_PRODUCT', 'UNLICENSED_INSTALL', 'UNLICENSED_INSTALL_STATEMENT']) {
    if (typeof module_?.[field] !== 'string' || !module_[field].trim()) {
      throw new Error(`${entitlementPath} does not export a non-empty ${field}.`)
    }
  }
  for (const field of ['TIERS', 'GATED_CAPABILITIES']) {
    if (!module_[field] || typeof module_[field] !== 'object') {
      throw new Error(`${entitlementPath} does not export a ${field} table.`)
    }
  }
  if (!Array.isArray(module_.NEVER_GATED) || module_.NEVER_GATED.length === 0) {
    throw new Error(
      `${entitlementPath} exports no NEVER_GATED list. That list is what a pricing page shows to stop the ` +
      'free product reading as a trial; emitting a catalog without it would be the omission that misleads.'
    )
  }
  return module_
}

function usd(value) {
  return Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * Turn the entitlement module into the exact object the browser reads.
 *
 * Pure, and exported, so tools/test/subscription-catalog.test.mjs can drive it
 * with a synthetic model instead of only against whatever engine tree happens
 * to be on the machine running the suite.
 */
export function buildCatalog(entitlement, { generatedAt } = {}) {
  /* Re-checked HERE and not only in loadEntitlement, because this function is
     the one that produces a catalog and is called directly by the suite. A
     validation that lives only on the CLI path is a validation the thing being
     validated can be built without. */
  if (!Array.isArray(entitlement?.NEVER_GATED) || entitlement.NEVER_GATED.length === 0) {
    throw new Error(
      'the model states no NEVER_GATED list, so a catalog built from it would show what money buys and nothing '
      + 'about what is free forever. That omission is the "free tier is really a trial" reading, and it is refused.'
    )
  }
  const capabilities = {}
  for (const [id, capability] of Object.entries(entitlement.GATED_CAPABILITIES)) {
    if (!capability || typeof capability.label !== 'string' || !capability.label.trim()) {
      throw new Error(`gated capability "${id}" has no label; a page cannot name what the model will not name.`)
    }
    if (typeof capability.rationale !== 'string' || !capability.rationale.trim()) {
      throw new Error(
        `gated capability "${id}" has no rationale. A paid inclusion with no stated reason is a line item, ` +
        'not an explanation, and this page is not allowed to charge for one.'
      )
    }
    if (!Array.isArray(capability.freeAlternatives) || capability.freeAlternatives.length === 0) {
      throw new Error(
        `gated capability "${id}" names no free alternative. The model's own doctrine (R1228) is that a gate ` +
        'which cannot name a free way to do the job is a hostage situation; the page must show the alternative.'
      )
    }
    if (!Array.isArray(capability.requiredTiers) || capability.requiredTiers.length === 0) {
      throw new Error(`gated capability "${id}" names no required tiers, so no plan can honestly include it.`)
    }
    capabilities[id] = {
      id,
      label: capability.label,
      rationale: capability.rationale,
      requiredTiers: [...capability.requiredTiers],
      freeAlternatives: [...capability.freeAlternatives]
    }
  }

  const plans = Object.values(entitlement.TIERS).map(tier => {
    const grants = Array.isArray(tier.grants) ? [...tier.grants] : []
    for (const id of grants) {
      if (!capabilities[id]) {
        throw new Error(
          `tier "${tier.id}" grants "${id}", which is not in GATED_CAPABILITIES. The page would have to invent ` +
          'a description for it, and inventing what a customer is buying is the defect this generator prevents.'
        )
      }
      /* A tier that grants a capability the capability itself does not admit
         that tier to is a contradiction inside the model. Whichever half is
         wrong, a price page built on it would state one of them as fact. */
      if (!capabilities[id].requiredTiers.includes(tier.id)) {
        throw new Error(
          `tier "${tier.id}" grants "${id}" but "${id}".requiredTiers does not include "${tier.id}". ` +
          'The model contradicts itself; a plan card built from it would publish the contradiction.'
        )
      }
    }
    return {
      id: tier.id,
      label: tier.label,
      qualifiedLabel: typeof tier.qualifiedLabel === 'string' ? tier.qualifiedLabel : tier.label,
      requiresLicense: tier.requiresLicense === true,
      monthlyUsd: usd(tier.monthlyUsd),
      annualUsd: usd(tier.annualUsd),
      seatMinimum: Number.isSafeInteger(tier.seatMinimum) && tier.seatMinimum > 0 ? tier.seatMinimum : null,
      productId: typeof tier.productId === 'string' ? tier.productId : null,
      grants
    }
  })

  if (!plans.some(plan => plan.requiresLicense)) {
    throw new Error('the model declares no paid plan, so there is nothing to sell and no page to build.')
  }
  for (const plan of plans.filter(candidate => candidate.requiresLicense)) {
    if (plan.monthlyUsd === null) {
      throw new Error(
        `paid plan "${plan.id}" has no monthlyUsd. A subscription page with a blank, "contact us" or guessed ` +
        'price for a plan the model prices is how a customer is charged something they were never shown.'
      )
    }
    if (!plan.productId) {
      throw new Error(
        `paid plan "${plan.id}" has no productId, so a payment for it could never be mapped back to a tier. ` +
        'Selling it would take money for an entitlement nothing can issue.'
      )
    }
  }

  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    domain: 'subscription-catalog',
    generatedAt: new Date(generatedAt ?? Date.now()).toISOString(),
    derivedFrom: 'src/lib/entitlement.js',
    paidProduct: entitlement.PAID_PRODUCT,
    unlicensedInstall: entitlement.UNLICENSED_INSTALL,
    unlicensedInstallStatement: entitlement.UNLICENSED_INSTALL_STATEMENT,
    neverGated: [...entitlement.NEVER_GATED],
    capabilities,
    plans
  }
}

function main() {
  const explicit = process.argv.includes('--source')
    ? process.argv[process.argv.indexOf('--source') + 1]
    : null
  const { root, entitlement: entitlementPath } = resolveEngineRoot(explicit)
  const catalog = buildCatalog(loadEntitlement(entitlementPath))

  mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true })
  writeFileSync(OUTPUT_FILE, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')

  console.log(`Engine tree: ${root}`)
  console.log(`Paid product: ${catalog.paidProduct}`)
  console.log(`Plans: ${catalog.plans.map(plan => `${plan.id}${plan.requiresLicense ? '' : ' (free)'}`).join(', ')}`)
  console.log(`Gated capabilities: ${Object.keys(catalog.capabilities).join(', ') || '(none)'}`)
  console.log(`Wrote ${path.relative(REPO_ROOT, OUTPUT_FILE)}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(`Subscription catalog generator error: ${error.message}`)
    process.exitCode = 2
  }
}
