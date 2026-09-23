#!/usr/bin/env node

/* THE APP AND THE WEBSITE MUST SELL THE SAME PRODUCT, BY NAME.
 *
 * On 2026-08-11 they did not. The live org profile at github.com/ToolsEnabled,
 * README.md, LICENSING.md, COMMERCIAL-LICENSE.md, CONTRIBUTORS.md and NOTICE all
 * sold "ToolsEnabled Anywhere". The engine's src/lib/entitlement.js named its
 * paid tiers "Operator Cloud" and "Team" and never said what product they were
 * tiers OF. Two names, one purchase, nothing connecting them.
 *
 * WHY THIS WAS STILL CHEAP TO FIX, AND WHY IT WAS ABOUT TO STOP BEING.
 * entitlement.js is `paid`-classified in config/payload-boundary.json, so it does
 * not ship: measured over the staged payload and the built renderer, "Operator
 * Cloud" appeared zero times and the only tier label a stranger's install carries
 * is "Community". So no customer had yet been shown the contradiction. The next
 * step on the launch list is creating the Stripe Products from that same tier
 * table -- and a Stripe Product name is what a customer reads on the checkout
 * page and on the receipt. Receipts are not editable after the fact. The window
 * for fixing this for free closes the moment those Products are created.
 *
 * WHAT THIS GUARD IS NOT. It is not a spell-checker for marketing copy, and it
 * does not decide the name. The name is the owner's: "The paid product is
 * ToolsEnabled Anywhere." The plan names are R1229's. This only asserts that the
 * two halves still agree, because nothing else did -- tests/entitlement.js has 65
 * assertions and not one of them looks at a label, which is exactly how the two
 * drifted apart without a single test going red.
 *
 * EXIT CODES follow tools/check-no-owner-data.mjs deliberately, because a build
 * script chains these together and a novel contract in one of them is a bug
 * waiting for a pipe: 0 clean, 1 an inconsistency was found, 2 a setup problem.
 * A setup problem must never be silently indistinguishable from a pass -- that is
 * the absence-as-emptiness defect this codebase has now found repeatedly, and a
 * naming guard that "passes" because it could not find the engine tree would be
 * the same hole in a new place.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/* The published documents. A document earns its place here by being something a
 * stranger reads BEFORE or WHILE deciding to pay -- the repository front page,
 * the licence explanation, the commercial terms, the org profile that renders at
 * github.com/ToolsEnabled. If a new customer-facing document starts describing
 * the paid product, it belongs in this list; that is a deliberate manual step,
 * because "which documents are public promises" is a judgement, not a glob.
 *
 * EXPORTED so tools/check-github-claims.mjs can read the same list rather than
 * keep a second copy of it. That guard asks a different question of the same
 * documents -- whether any of them claims the product runs on GitHub -- and if
 * the two ever disagreed about WHICH documents are published, one of them would
 * be guarding a file nobody reads while the other missed one everybody does.
 */
export const PUBLISHED_DOCUMENTS = [
  'README.md',
  'LICENSING.md',
  'COMMERCIAL-LICENSE.md',
  'CONTRIBUTORS.md',
  'NOTICE',
  path.join('docs', 'github-org', 'profile-README.md')
]

/* PLAN LABELS THAT ARE ALSO ORDINARY ENGLISH, AND SO CANNOT BE MATCHED IN PROSE.
 *
 * Rule 3 below looks for a plan name quoted in a document without the product
 * name beside it. "Operator Cloud" is a distinctive phrase and that works. "Team"
 * is not -- CONTRIBUTORS.md and README.md use the word in its ordinary sense, and
 * matching it would report a naming defect on every sentence about people working
 * together. A guard that cries wolf on correct prose gets deleted, and then rule 3
 * protects nothing at all.
 *
 * This is a narrowing of what rule 3 can SEE, so it is recorded here rather than
 * hidden in a filter expression: "Team" is still checked by rules 1 and 2, which
 * read the tier table directly and do not depend on prose matching.
 */
const AMBIGUOUS_PLAN_LABELS = new Set(['Team'])

const SOURCE_SETTING_FILE = path.join(REPO_ROOT, 'private', 'capability-source.owner.json')

/* Same precedence as tools/pack-capability-layer.mjs, on purpose: a build that
 * stages the payload from one engine tree must not check names against another.
 */
function resolveEngineRoot(explicit) {
  let configured = null
  if (existsSync(SOURCE_SETTING_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(SOURCE_SETTING_FILE, 'utf8'))
      if (parsed && typeof parsed.path === 'string' && parsed.path.trim()) configured = parsed.path.trim()
    } catch (error) {
      throw new Error(`private/capability-source.owner.json is present but unreadable: ${error.message}`)
    }
  }

  const candidate = [explicit, process.env.TOOLSENABLED_SOURCE, configured].filter(Boolean)[0]
  if (!candidate) {
    throw new Error(
      'cannot find the capability-layer source tree, so the product name in the app cannot be compared ' +
      'with the product name in the published documents. Set one of: --source <path>, ' +
      'TOOLSENABLED_SOURCE=<path>, or private/capability-source.owner.json'
    )
  }

  const resolved = path.resolve(candidate)
  const entitlement = path.join(resolved, 'src', 'lib', 'entitlement.js')
  if (!existsSync(entitlement)) {
    throw new Error(`no src/lib/entitlement.js under the configured capability source: ${resolved}`)
  }
  return { root: resolved, entitlement }
}

/* LOADED, NOT PARSED. A regex over the file would assert what the source text
 * says; requiring it asserts what the module actually exports, which is what any
 * billing or settings surface would really read. Source-text assertions cannot
 * see reachability -- a label behind a stale branch greps identically to a live
 * one.
 */
function loadEntitlement(entitlementPath) {
  const require_ = createRequire(import.meta.url)
  let module_
  try {
    module_ = require_(entitlementPath)
  } catch (error) {
    throw new Error(`could not load ${entitlementPath}: ${error.message}`)
  }
  if (!module_ || typeof module_.PAID_PRODUCT !== 'string' || !module_.PAID_PRODUCT.trim()) {
    throw new Error(
      `${entitlementPath} does not export a non-empty PAID_PRODUCT. That constant is the single ` +
      'place the paid product is named; without it every surface is free to invent its own name again.'
    )
  }
  if (!module_.TIERS || typeof module_.TIERS !== 'object') {
    throw new Error(`${entitlementPath} does not export a TIERS table.`)
  }
  return module_
}

function main() {
  const explicit = process.argv.includes('--source')
    ? process.argv[process.argv.indexOf('--source') + 1]
    : null

  const { root, entitlement: entitlementPath } = resolveEngineRoot(explicit)
  const entitlement = loadEntitlement(entitlementPath)
  const product = entitlement.PAID_PRODUCT
  const tiers = Object.values(entitlement.TIERS)
  const paidTiers = tiers.filter((tier) => tier.requiresLicense)
  const problems = []

  console.log(`Engine tree: ${root}`)
  console.log(`Paid product, as the app names it: ${JSON.stringify(product)}`)

  if (paidTiers.length === 0) problems.push('TIERS declares no paid tier, so there is nothing to sell and nothing to name.')

  /* 1. A paid plan must never be quotable without its product. `qualifiedLabel`
   *    is the field a checkout line, a receipt or a refusal is supposed to use;
   *    if it does not carry the product name it is just the bare plan name with
   *    extra steps, which is the defect this guard exists for.
   */
  for (const tier of paidTiers) {
    if (typeof tier.qualifiedLabel !== 'string' || !tier.qualifiedLabel.startsWith(product)) {
      problems.push(
        `tier "${tier.id}" has qualifiedLabel ${JSON.stringify(tier.qualifiedLabel)}, which does not begin with ` +
        `the paid product name ${JSON.stringify(product)}. A customer reading it cannot tell which product they bought.`
      )
    }
  }

  /* 2. The free tier must NOT be dressed as a plan of the paid product. Telling
   *    someone who bought nothing that they hold the paid product's entry tier is
   *    the "free tier is really a trial" reading R1228/R1229 explicitly refuse.
   */
  for (const tier of tiers.filter((candidate) => !candidate.requiresLicense)) {
    if (typeof tier.qualifiedLabel === 'string' && tier.qualifiedLabel.includes(product)) {
      problems.push(
        `free tier "${tier.id}" carries the paid product name in ${JSON.stringify(tier.qualifiedLabel)}. ` +
        'The free product is not a tier of the paid one.'
      )
    }
  }

  /* 3. Every published document must name the product exactly as the app does,
   *    and must not name a paid PLAN without it -- that is the direction the two
   *    actually drifted, and the direction a reader is misled by.
   */
  const planNames = paidTiers.map((tier) => tier.label).filter((label) => label && !AMBIGUOUS_PLAN_LABELS.has(label))
  for (const relative of PUBLISHED_DOCUMENTS) {
    const file = path.join(REPO_ROOT, relative)
    if (!existsSync(file)) {
      problems.push(`published document is missing: ${relative}`)
      continue
    }
    const text = readFileSync(file, 'utf8')
    const namesProduct = text.includes(product)
    if (!namesProduct) {
      problems.push(
        `${relative} never names the paid product ${JSON.stringify(product)}. ` +
        'A published document that describes what is sold must call it what the app calls it.'
      )
    }
    for (const plan of planNames) {
      if (text.includes(plan) && !namesProduct) {
        problems.push(
          `${relative} names the plan ${JSON.stringify(plan)} but never names the product ` +
          `${JSON.stringify(product)} it is a plan of.`
        )
      }
    }
    console.log(`  ${relative}: names product=${namesProduct}`)
  }

  if (problems.length > 0) {
    console.error('\nProduct naming is inconsistent:')
    for (const problem of problems) console.error(`  - ${problem}`)
    console.error(
      '\nThe paid product name and the plan names are both R1229\'s -- adopted by a five-seat council convened ' +
      'at the owner\'s instruction, and NOT quoted from him: "Anywhere" and "$19" each appear 0 times in ' +
      'reports/OWNER-REQUEST-LEDGER.json. Fix the disagreement; do not rename either to make this pass, and do ' +
      'not re-describe the name as his decision without a ledger citation.'
    )
    process.exitCode = 1
    return
  }

  console.log(`\nChecked ${PUBLISHED_DOCUMENTS.length} published documents and ${paidTiers.length} paid plans. Consistent.`)
}

/* RUN AS A COMMAND, NOT ON IMPORT. Same shape as tools/check-plain-language.mjs
 * and tools/check-subscription-claims.mjs, and it is not cosmetic here: this file
 * now exports PUBLISHED_DOCUMENTS, and an unguarded main() would mean that
 * importing that list runs the whole naming check as a side effect -- against an
 * engine tree the importer never asked for, setting the importer's exit code.
 * The command-line behaviour is unchanged. */
if (
  process.argv[1] &&
  realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url))
) {
  try {
    main()
  } catch (error) {
    console.error(`Product-naming guard error: ${error.message}`)
    process.exitCode = 2
  }
}
