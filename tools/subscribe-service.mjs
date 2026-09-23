#!/usr/bin/env node

/* THE SIGNUP SERVICE, AS A COMMAND AND AS A MODULE THE SUITES IMPORT.
 *
 * The service ITSELF now lives in shell/subscribe-service.cjs. It moved there
 * because package.json's build.files excludes tools/** from the archive: while
 * the service lived here, the shipped application contained a subscription page
 * that posts to /v1/signup and nothing anywhere that answers there. Read the
 * header of shell/subscribe-service.cjs for the whole of that story; this file
 * is what remains on the BUILDER's side of the line.
 *
 * Three things are left here, and each one is a thing a customer's machine must
 * not be able to do:
 *
 *   1. loadEngineModel -- read the engine's own src/lib/entitlement.js and
 *      src/lib/entitlement-fulfilment.js. The shipped payload deliberately does
 *      not contain those modules, so this can only run where the engine tree is.
 *
 *   2. buildSignupModel / --emit-model -- turn that engine model into the small
 *      shipped JSON the packaged endpoint reads instead. This is the pack-time
 *      half of "the product does not read the engine at runtime".
 *
 *   3. the standalone server, for driving the service on its own port.
 *
 * Everything the service exports is re-exported unchanged, so every existing
 * importer -- tools/test/subscribe-service.test.mjs, tools/subscribe-page-drive.mjs
 * -- keeps working against exactly one copy of the code.
 */

import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveEngineRoot } from './gen-subscription-catalog.mjs'

const require_ = createRequire(import.meta.url)
const service = require_('../shell/subscribe-service.cjs')

export const {
  DEFAULT_MODEL,
  DEFAULT_PRICES,
  DEFAULT_STORE,
  SIGNUP_MODEL_SCHEMA_VERSION,
  SignupRefusal,
  SignupStore,
  accountKey,
  accountSubscriptionState,
  createCheckoutProvider,
  createHttpHandler,
  createSignupService,
  listen,
  readPriceMap,
  readSignupModel,
} = service

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The engine's own answer to "what is sold, and what must a paid session carry".
 *
 * Only available where the engine checkout is. Everything downstream of a build
 * reads the emitted model instead.
 */
export function loadEngineModel(explicit) {
  const { entitlement } = resolveEngineRoot(explicit)
  const model = require_(entitlement)
  const fulfilment = require_(path.join(path.dirname(entitlement), 'entitlement-fulfilment.js'))
  return { TIERS: model.TIERS, REQUIRED_METADATA: fulfilment.REQUIRED_METADATA }
}

/**
 * The shipped model, derived from the engine one.
 *
 * IT CARRIES ONLY WHAT THE SERVICE READS. planFor() reads requiresLicense, id
 * and label; the seats and period rules read seatMinimum and whether an annual
 * period exists; the metadata names are what fulfilment demands. Copying the
 * whole tier table instead would ship fields nobody reads and invite the next
 * person to read one.
 *
 * AND IT BROKE THAT RULE WITH A PRICE, WHICH IS WHY THIS COMMENT IS LONGER NOW.
 * The emitted model carried `monthlyUsd` -- 0, 19 and 299 -- and
 * `grep -rn monthlyUsd shell/` matches only the three lines of the JSON itself:
 * NOTHING in the shipped service reads it, ever. So the one field this file's
 * own rule forbids is the field that put an unauthorised Team price of 299
 * inside app.asar (`shell/**` is in build.files, and check-asar-manifest
 * REQUIRES every file under it to be in the archive), in a release whose rule is
 * "we are NOT collecting payments at first public launch" (R1214). It is gone.
 *
 * `annualUsd` was read, but only ever as a yes/no: subscribe-service.cjs asked
 * `Number.isFinite(plan.annualUsd) && plan.annualUsd > 0` to decide whether to
 * refuse an annual period, and printed the number nowhere. A price shipped so a
 * boolean could be computed from it. `annualOffered` is that boolean, so the
 * service still refuses "the Operator Cloud plan is not offered annually" for
 * exactly the plans it did before, with no amount in the payload.
 *
 * WHAT IS LEFT IS NOT A PRICE: an id, a customer-facing label, whether the plan
 * needs a licence, whether an annual period exists, and a seat floor. See the
 * note on seatMinimum below -- it is a real finding, and it is not this lane's
 * to change.
 *
 * Pure and exported so the suite can drive it with a synthetic model rather than
 * only against whatever engine tree happens to be on the machine running it.
 */
export function buildSignupModel(engine, { generatedAt } = {}) {
  if (!engine?.TIERS || !engine?.REQUIRED_METADATA) {
    throw new Error('the engine model states no TIERS or no REQUIRED_METADATA, so no signup model can be derived from it.')
  }
  for (const key of ['tier', 'pairId']) {
    const name = engine.REQUIRED_METADATA[key]
    if (typeof name !== 'string' || !name.trim()) {
      throw new Error(
        `the engine names no "${key}" metadata key, so a session built from this model would be charged and never `
        + 'fulfilled. Refusing to emit a model that cannot produce a licence.')
    }
  }
  const tiers = {}
  for (const [id, tier] of Object.entries(engine.TIERS)) {
    if (!tier || typeof tier.label !== 'string' || !tier.label.trim()) {
      throw new Error(`tier "${id}" has no label; a refusal built from it could not name the plan it refused.`)
    }
    tiers[id] = {
      id,
      label: tier.label,
      requiresLicense: tier.requiresLicense === true,
      /* The question the period rule actually asks, instead of the amount it
         asked it of. No price reaches the payload from here. */
      annualOffered: Number.isFinite(tier.annualUsd) && tier.annualUsd > 0,
      /* A SEAT FLOOR THE ENGINE NO LONGER DECLARES, RECORDED RATHER THAN
         SILENTLY CHANGED. engine src/lib/entitlement.js TIERS.team now says, in
         the record itself: "This table declares only values the entitlement
         system enforces. Seat or device limits belong in a separately enforced
         catalog contract and must not be inferred from this plan record", and
         its RESERVED_TIERS note adds "which is precisely why `seatMinimum` was
         deleted from `team` above". So this line reads null from the current
         engine, while the committed shell/subscription-signup-model.json -- and
         config/subscription-catalog.json, which the drift guard treats as the
         fixed point -- still say 3, from the 2026-08-12 generation. That is
         drift about a PLAN TERM, not a price, it changes which seats a Team
         signup would refuse, and its authority belongs to whoever owns the
         catalog contract. Left as it stands and named, not quietly resolved. */
      seatMinimum: Number.isSafeInteger(tier.seatMinimum) && tier.seatMinimum > 0 ? tier.seatMinimum : null,
    }
  }
  if (!Object.values(tiers).some(tier => tier.requiresLicense)) {
    throw new Error('the engine declares no plan that needs a licence, so there is nothing for a signup service to sell.')
  }
  return {
    schemaVersion: SIGNUP_MODEL_SCHEMA_VERSION,
    domain: 'subscription-signup-model',
    generatedAt: new Date(generatedAt ?? Date.now()).toISOString(),
    derivedFrom: 'src/lib/entitlement.js + src/lib/entitlement-fulfilment.js',
    requiredMetadata: {
      tier: engine.REQUIRED_METADATA.tier,
      pairId: engine.REQUIRED_METADATA.pairId,
    },
    tiers,
  }
}

function argOf(name, fallback = null) {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

function emitModel() {
  /* `--emit-model` with no path writes the file the packaged endpoint reads.
     A following argument that starts with `-` is the NEXT flag, not a path:
     treating it as one would write the model to a file called "--source". */
  const named = argOf('--emit-model')
  const file = path.resolve(named && !named.startsWith('-') ? named : DEFAULT_MODEL)
  const model = buildSignupModel(loadEngineModel(argOf('--source')))
  writeFileSync(file, `${JSON.stringify(model, null, 2)}\n`, 'utf8')
  console.log(`Plans: ${Object.values(model.tiers).map(tier => `${tier.id}${tier.requiresLicense ? '' : ' (free)'}`).join(', ')}`)
  console.log(`Required session metadata: ${model.requiredMetadata.tier}, ${model.requiredMetadata.pairId}`)
  console.log(`Wrote ${path.relative(REPO_ROOT, file)}`)
}

async function main() {
  if (process.argv.includes('--emit-model')) { emitModel(); return }
  const port = Number(argOf('--port', '4620'))
  const provider = createCheckoutProvider({
    mode: process.env.TOOLSENABLED_BILLING_MODE,
    secretKey: process.env.TOOLSENABLED_BILLING_TEST_KEY,
    apiBase: process.env.TOOLSENABLED_BILLING_API_BASE
  })
  const signupService = createSignupService({
    /* The engine directly, not the emitted model: this command is the builder's
       own harness and it must fail loudly when the engine tree is absent, rather
       than quietly serving whatever a stale emitted file happens to say. */
    engine: loadEngineModel(argOf('--source')),
    priceMap: readPriceMap(argOf('--prices', DEFAULT_PRICES)),
    provider,
    store: new SignupStore(argOf('--store', DEFAULT_STORE)),
    siteOrigin: argOf('--site', 'http://127.0.0.1:4600')
  })
  await listen({ handler: createHttpHandler(signupService, { allowOrigin: argOf('--allow-origin') }), port })
  console.log(`subscribe-service listening on http://127.0.0.1:${port} (provider mode: ${provider.mode}, base: ${provider.apiBase})`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`subscribe-service refused to start: ${error?.reason || error?.message || error}`)
    process.exitCode = 2
  })
}
