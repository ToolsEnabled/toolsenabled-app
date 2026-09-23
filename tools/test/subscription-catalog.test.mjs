// THE PAGE MUST NOT BE ABLE TO PROMISE WHAT THE MODEL DOES NOT GRANT.
//
// These tests drive the derivation and the guard against SYNTHETIC entitlement
// models rather than only against whichever engine tree happens to be checked
// out on this machine, so a rule can be proved to fire without anybody editing
// the real product's price list to make it fire.
//
// ABSENCE IS TESTED BEFORE PRESENCE throughout, per the rule this codebase
// keeps re-learning: the interesting failure is never "the wrong value was
// shown", it is "nothing was there and something was shown anyway".

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

import { buildCatalog } from '../gen-subscription-catalog.mjs'
import { comparable, hardcodedMoney, readPromiseRegister, unbackedPromises } from '../check-subscription-claims.mjs'
import { freePlan, planInclusions, purchasablePlans, validateCatalog } from '../../src/subscription-catalog.js'

/** A minimal but complete stand-in for src/lib/entitlement.js. */
function model(overrides = {}) {
  return {
    PAID_PRODUCT: 'Example Anywhere',
    UNLICENSED_INSTALL: 'full-function',
    UNLICENSED_INSTALL_STATEMENT: 'This installation is fully functional without a licence, permanently.',
    NEVER_GATED: ['the local runtime', 'your own data'],
    GATED_CAPABILITIES: {
      'hosted-relay': {
        id: 'hosted-relay',
        label: 'Relay hosted by us',
        rationale: 'A server we pay for and keep online.',
        requiredTiers: ['operator'],
        freeAlternatives: ['run the same relay yourself']
      }
    },
    TIERS: {
      community: { id: 'community', label: 'Community', qualifiedLabel: 'Community', monthlyUsd: 0, requiresLicense: false, productId: null, grants: [] },
      operator: { id: 'operator', label: 'Operator Cloud', qualifiedLabel: 'Example Anywhere -- Operator Cloud', monthlyUsd: 19, annualUsd: 190, requiresLicense: true, productId: 'example.operator.v1', grants: ['hosted-relay'] }
    },
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// buildCatalog -- what the page is given
// ---------------------------------------------------------------------------

test('a derived catalog carries the free side, not only the paid one', () => {
  const catalog = buildCatalog(model(), { generatedAt: 0 })
  assert.equal(catalog.paidProduct, 'Example Anywhere')
  assert.deepEqual(catalog.neverGated, ['the local runtime', 'your own data'])
  assert.match(catalog.unlicensedInstallStatement, /fully functional/)
  assert.equal(catalog.plans.length, 2)
})

test('a tier granting a capability the model does not declare is refused, not described', () => {
  const broken = model()
  broken.TIERS.operator = { ...broken.TIERS.operator, grants: ['hosted-relay', 'telepathy'] }
  assert.throws(() => buildCatalog(broken), /not in GATED_CAPABILITIES/)
})

test('a tier granting a capability that does not admit that tier is refused as a contradiction', () => {
  const broken = model()
  broken.GATED_CAPABILITIES['hosted-relay'] = { ...broken.GATED_CAPABILITIES['hosted-relay'], requiredTiers: ['team'] }
  assert.throws(() => buildCatalog(broken), /contradicts itself/)
})

test('a gated capability with no free alternative is refused', () => {
  const broken = model()
  broken.GATED_CAPABILITIES['hosted-relay'] = { ...broken.GATED_CAPABILITIES['hosted-relay'], freeAlternatives: [] }
  assert.throws(() => buildCatalog(broken), /names no free alternative/)
})

test('a gated capability with no rationale is refused -- a paid line with no reason is not an explanation', () => {
  const broken = model()
  broken.GATED_CAPABILITIES['hosted-relay'] = { ...broken.GATED_CAPABILITIES['hosted-relay'], rationale: '   ' }
  assert.throws(() => buildCatalog(broken), /no rationale/)
})

test('a paid plan with no price is refused rather than emitted with a blank', () => {
  const broken = model()
  broken.TIERS.operator = { ...broken.TIERS.operator, monthlyUsd: null }
  assert.throws(() => buildCatalog(broken), /has no monthlyUsd/)
})

test('a paid plan that cannot be mapped back to a licensed product is refused', () => {
  const broken = model()
  broken.TIERS.operator = { ...broken.TIERS.operator, productId: null }
  assert.throws(() => buildCatalog(broken), /no productId/)
})

test('a model with no paid plan is refused -- there is nothing to sell', () => {
  const broken = model()
  delete broken.TIERS.operator
  assert.throws(() => buildCatalog(broken), /no paid plan/)
})

test('a model with no NEVER_GATED list is refused, because the free column would be missing', () => {
  assert.throws(() => buildCatalog(model({ NEVER_GATED: [] })), /NEVER_GATED/)
})

// ---------------------------------------------------------------------------
// validateCatalog -- what the browser refuses to render
// ---------------------------------------------------------------------------

test('the browser reader accepts a well-formed catalog', () => {
  const result = validateCatalog(buildCatalog(model(), { generatedAt: 0 }))
  assert.equal(result.ok, true)
})

test('an ABSENT catalog is not an empty one', () => {
  for (const absent of [null, undefined, '', 0, []]) {
    const result = validateCatalog(absent)
    assert.equal(result.ok, false, `${JSON.stringify(absent)} must not validate`)
  }
})

test('an unrecognised schemaVersion refuses rather than being read optimistically', () => {
  const catalog = { ...buildCatalog(model(), { generatedAt: 0 }), schemaVersion: 2 }
  const result = validateCatalog(catalog)
  assert.equal(result.ok, false)
  assert.match(result.reason, /schemaVersion/)
})

test('a paid plan with a zero price refuses -- a free-looking paid plan is the worst possible render', () => {
  const catalog = buildCatalog(model(), { generatedAt: 0 })
  catalog.plans = catalog.plans.map(plan => (plan.id === 'operator' ? { ...plan, monthlyUsd: 0 } : plan))
  const result = validateCatalog(catalog)
  assert.equal(result.ok, false)
  assert.match(result.reason, /no price/)
})

test('a plan including a capability the catalog does not describe refuses', () => {
  const catalog = buildCatalog(model(), { generatedAt: 0 })
  catalog.plans = catalog.plans.map(plan => (plan.id === 'operator' ? { ...plan, grants: ['ghost'] } : plan))
  const result = validateCatalog(catalog)
  assert.equal(result.ok, false)
  assert.match(result.reason, /does not describe/)
})

test('a catalog with no free-forever statement refuses, so the paid column is never shown alone', () => {
  const catalog = buildCatalog(model(), { generatedAt: 0 })
  catalog.neverGated = []
  const result = validateCatalog(catalog)
  assert.equal(result.ok, false)
  assert.match(result.reason, /free forever/)
})

test('inclusion lines come only from the plan grants, never from a free-text field', () => {
  const catalog = buildCatalog(model(), { generatedAt: 0 })
  const operator = purchasablePlans(catalog)[0]
  const inclusions = planInclusions(catalog, operator)
  assert.equal(inclusions.length, 1)
  assert.equal(inclusions[0].label, 'Relay hosted by us')
  // the free plan grants nothing, so it can render no inclusion at all
  assert.deepEqual(planInclusions(catalog, freePlan(catalog)), [])
})

// ---------------------------------------------------------------------------
// The guard -- rule 2 and rule 3
// ---------------------------------------------------------------------------

test('a promise for a capability the model never declares is a violation naming it', () => {
  const catalog = buildCatalog(model(), { generatedAt: 0 })
  const violations = unbackedPromises(
    [{ capability: 'website-access', includedWithTiers: ['operator'], provenance: 'OWNER-STATED R1266' }],
    catalog
  )
  assert.equal(violations.length, 1)
  assert.match(violations[0], /website-access/)
  assert.match(violations[0], /GATED_CAPABILITIES declares no such capability/)
})

test('a promise for a tier the capability does not admit is a violation', () => {
  const withTeam = model()
  withTeam.TIERS.team = { id: 'team', label: 'Team', qualifiedLabel: 'Example Anywhere -- Team', monthlyUsd: 299, requiresLicense: true, productId: 'example.team.v1', grants: [] }
  const catalog = buildCatalog(withTeam, { generatedAt: 0 })
  const violations = unbackedPromises(
    [{ capability: 'hosted-relay', includedWithTiers: ['team'], provenance: 'test' }],
    catalog
  )
  assert.ok(violations.length >= 1)
  assert.ok(violations.some(line => /Team is not among them/.test(line)))
})

test('a promise the model genuinely grants is not a violation', () => {
  const catalog = buildCatalog(model(), { generatedAt: 0 })
  assert.deepEqual(
    unbackedPromises([{ capability: 'hosted-relay', includedWithTiers: ['operator'], provenance: 'test' }], catalog),
    []
  )
})

test('an empty register is vacuously clean -- and that is why a MISSING one must not be', () => {
  const catalog = buildCatalog(model(), { generatedAt: 0 })
  assert.deepEqual(unbackedPromises([], catalog), [])
})

test('a missing promise register is a setup error, never an empty register', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'sub-promises-'))
  try {
    assert.throws(() => readPromiseRegister(path.join(directory, 'nope.json')), /no promise register/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('a register whose promises key is missing is refused, not read as zero promises', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'sub-promises-'))
  const file = path.join(directory, 'register.json')
  try {
    writeFileSync(file, JSON.stringify({ schemaVersion: 1 }), 'utf8')
    assert.throws(() => readPromiseRegister(file), /no "promises" array/)
    writeFileSync(file, JSON.stringify({ promises: [] }), 'utf8')
    assert.deepEqual(readPromiseRegister(file).promises, [])
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('a promise with no provenance is refused -- an unattributed promise cannot be told from an invented one', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'sub-promises-'))
  const file = path.join(directory, 'register.json')
  try {
    writeFileSync(file, JSON.stringify({ promises: [{ capability: 'x', includedWithTiers: ['operator'] }] }), 'utf8')
    assert.throws(() => readPromiseRegister(file), /no provenance/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

/* Rule 1 was covered only by the mutation battery's data mutation (M26), and
   M26 SURVIVED: the comparison used JSON.stringify's replacer-array argument as
   if it were a sort order, so it compared two nearly-empty strings and reported
   any two catalogs as identical. These are the tests that would have caught it
   on the way in. Each one changes exactly one nested value -- the level the
   broken version could not see. */
test('rule 1 sees a changed PRICE deep inside the catalog', () => {
  const catalog = buildCatalog(model(), { generatedAt: 0 })
  const drifted = { ...catalog, plans: catalog.plans.map(plan => (plan.id === 'operator' ? { ...plan, monthlyUsd: 29 } : plan)) }
  assert.notEqual(comparable(catalog), comparable(drifted))
})

test('rule 1 sees a changed capability LABEL, a changed plan NAME and a changed grant', () => {
  const catalog = buildCatalog(model(), { generatedAt: 0 })
  const relabelled = { ...catalog, capabilities: { ...catalog.capabilities, 'hosted-relay': { ...catalog.capabilities['hosted-relay'], label: 'Something else' } } }
  assert.notEqual(comparable(catalog), comparable(relabelled))
  const renamed = { ...catalog, plans: catalog.plans.map(plan => (plan.id === 'operator' ? { ...plan, label: 'Pro' } : plan)) }
  assert.notEqual(comparable(catalog), comparable(renamed))
  const regranted = { ...catalog, plans: catalog.plans.map(plan => (plan.id === 'operator' ? { ...plan, grants: [] } : plan)) }
  assert.notEqual(comparable(catalog), comparable(regranted))
})

test('rule 1 ignores the generation clock and key ordering, which are not claims', () => {
  const first = buildCatalog(model(), { generatedAt: 0 })
  const second = buildCatalog(model(), { generatedAt: 999_999 })
  assert.equal(comparable(first), comparable(second))
  const reordered = JSON.parse(JSON.stringify(first))
  reordered.plans = reordered.plans.map(plan => Object.fromEntries(Object.entries(plan).reverse()))
  assert.equal(comparable(first), comparable(reordered))
})

test('rule 3 finds a currency literal in executable code', () => {
  assert.ok(hardcodedMoney('const label = "$19 a month"', []).length > 0)
})

test('rule 3 finds one of the model\'s own prices restated in code', () => {
  const findings = hardcodedMoney('const monthly = 19', [19, 190])
  assert.equal(findings.length, 1)
  assert.match(findings[0], /the number 19/)
})

test('rule 3 does NOT fire on the comment that explains why prices are not here', () => {
  const source = `/* This page does not know that a plan costs $19 a month. */\nconst x = 1`
  assert.deepEqual(hardcodedMoney(source, [19, 190]), [])
})

test('rule 3 does not fire on an unrelated number that merely contains a price digit sequence', () => {
  assert.deepEqual(hardcodedMoney('const version = 1.190', [190]), [])
  assert.deepEqual(hardcodedMoney('const id = "a190b"', [190]), [])
})

/* RULE 4: THE LAUNCH SURFACE CARRIES NO PRICE LIST.
 *
 * The catalog was authored at public/data/subscription-catalog.json. vite copies
 * public/** into dist/ and package.json build.files packs dist/**, so it shipped
 * in every installer, and #/subscribe and #/pricing rendered it: plan names,
 * monthly and annual prices, a Team price and a three-seat minimum, generated
 * 2026-08-12. R1214 records that catalog as unauthorised and the owner's release
 * rule as "we are NOT collecting payments at first public launch".
 *
 * These assertions are about BYTES, not about a flag, because that is the only
 * property a packaged build cannot undo by itself: no environment variable, no
 * setting and no stored preference can put a file back into an installer. */

test('the renderer payload carries no price catalog, and the manifest records that as a decision', () => {
  const payloadCatalog = path.join(REPO_ROOT, 'public', 'data', 'subscription-catalog.json')
  assert.equal(existsSync(payloadCatalog), false,
    'mutation `regenerate the catalog into public/data/` survived: expected no price list under public/, which vite copies into dist/ verbatim')

  const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'config', 'renderer-payload-boundary.json'), 'utf8'))
  assert.equal(manifest.shipped.paths.includes('data/subscription-catalog.json'), false,
    'mutation `move the catalog back to shipped` survived: expected the price catalog not to be classified as a product asset strangers receive')
  assert.equal(manifest.withheld.paths.includes('data/subscription-catalog.json'), true,
    'mutation `delete the withheld classification` survived: expected the decision to be recorded where tools/check-renderer-payload.mjs enforces it')

  /* The generated catalog itself still exists, out of the payload: rule 1 needs
     a file to compare against the model, and a drift check with nothing to
     check is the failure this whole suite exists to refuse. */
  assert.equal(existsSync(path.join(REPO_ROOT, 'config', 'subscription-catalog.json')), true,
    'mutation `delete the catalog outright` survived: expected the generated catalog to remain at config/subscription-catalog.json for rule 1')
})

test('rule 4 fires on a catalog restored to the payload, and its refusal says what the owner ruled', () => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'subscription-rule4-'))
  try {
    mkdirSync(path.join(fixture, 'tools'), { recursive: true })
    mkdirSync(path.join(fixture, 'public', 'data'), { recursive: true })
    for (const name of ['check-subscription-claims.mjs', 'gen-subscription-catalog.mjs']) {
      writeFileSync(path.join(fixture, 'tools', name), readFileSync(path.join(REPO_ROOT, 'tools', name)))
    }
    writeFileSync(path.join(fixture, 'public', 'data', 'subscription-catalog.json'), '{"schemaVersion":1}\n')
    const gate = path.join(fixture, 'tools', 'check-subscription-claims.mjs')
    /* No engine, so the run stops at setup (exit 2) before rule 4 is reached.
       What is asserted here is the CONSTANT, read out of the gate's own source:
       a rule whose subject path drifted back to config/ would pass this suite
       while guarding nothing. */
    const source = readFileSync(gate, 'utf8')
    assert.match(source, /PAYLOAD_CATALOG_FILE = path\.join\(REPO_ROOT, 'public', 'data', 'subscription-catalog\.json'\)/,
      'mutation `point rule 4 at the new path` survived: expected rule 4 to watch the payload directory, not the directory the catalog moved to')
    assert.match(source, /rule 4 the renderer payload carries no price catalog/,
      'mutation `delete rule 4` survived: expected the guard to report rule 4 when the payload is clean')
    assert.match(source, /payments are not collected[\s\S]{0,200}R1214/,
      'mutation `drop the reason from the refusal` survived: expected the refusal to name the owner rule and the ledger entry it enforces')
    assert.match(source, /the generated catalog belongs at config\/subscription-catalog\.json/,
      'mutation `refuse without a next step` survived: expected the refusal to say where the catalog does belong')
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})
