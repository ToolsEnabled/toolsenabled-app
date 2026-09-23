// THE THING THAT ANSWERS AT /v1/signup, AND WHETHER IT IS THERE AT ALL.
//
// tools/test/subscribe-service.test.mjs already proves the service refuses
// correctly. Every one of those tests passed while the shipped application had
// no endpoint whatsoever: the service lived under tools/, which package.json
// excludes from the archive, and the shell's file server answered the signup
// POST with index.html and a 200. So this suite is about the MOUNT rather than
// about the service -- the half that was missing, and the half whose absence a
// green service suite could not see.
//
// THE FALLBACK IS PART OF THE FIXTURE ON PURPOSE. Each server below ends in the
// same SPA fallback serveDist() has: unknown path -> index.html, 200, text/html.
// A test whose fixture only mounts the endpoint cannot tell "the endpoint
// answered" from "nothing else was there to answer", which is precisely the
// confusion that let the defect ship.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require_ = createRequire(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const {
  SIGNUP_PATH,
  createSubscribeEndpoint,
  handlesSignupUrl,
  withoutPaths,
} = require_('../../shell/subscribe-endpoint.cjs')
const { SignupRefusal, readSignupModel } = require_('../../shell/subscribe-service.cjs')

const SHIPPED_MODEL = path.join(REPO_ROOT, 'shell', 'subscription-signup-model.json')
/* Not under public/ any more: R1214 took the price catalog out of the renderer
   payload, so this drift guard reads it where the generator now writes it. What
   it compares is unchanged -- the two artefacts derived from the same engine
   tables must still agree about what is sold. */
const SHIPPED_CATALOG = path.join(REPO_ROOT, 'config', 'subscription-catalog.json')

const PRICES = {
  mode: 'test',
  prices: {
    'operator:monthly': 'price_test_op_m',
    'operator:annual': 'price_test_op_a',
    'team:monthly': 'price_test_team_m',
  },
}

function workspace(t, { prices = PRICES } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'sub-endpoint-'))
  t.after(() => { try { rmSync(directory, { recursive: true, force: true }) } catch { /* gone */ } })
  const pricesFile = path.join(directory, 'subscription-prices.json')
  if (prices) writeFileSync(pricesFile, `${JSON.stringify(prices, null, 2)}\n`, 'utf8')
  return { directory, pricesFile, storeFile: path.join(directory, 'subscription-signups.json') }
}

function fakeProvider() {
  const seen = []
  return {
    seen,
    async createSession(input) {
      seen.push(input)
      return { id: `cs_test_${seen.length}`, url: `https://pay.example/cs_test_${seen.length}`, testMode: true }
    },
  }
}

/** A server shaped like serveDist(): the endpoint first, the SPA fallback last. */
async function site(t, endpoint) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (endpoint.serve(url.pathname, request, response)) return
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<!doctype html><html><body>the app shell</body></html>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  return `http://127.0.0.1:${server.address().port}`
}

async function post(origin, body) {
  const response = await fetch(`${origin}${SIGNUP_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  const text = await response.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { /* the assertions report it */ }
  return { status: response.status, type: response.headers.get('content-type') || '', text, body: parsed }
}

const GOOD = {
  email: 'buyer@example.com',
  planId: 'operator',
  billingPeriod: 'monthly',
  seats: null,
  idempotencyKey: 'attempt-00000001',
}

// ---------------------------------------------------------------------------
// Routing: what the endpoint takes, and what it leaves alone
// ---------------------------------------------------------------------------

test('the endpoint claims the signup routes and nothing else', () => {
  assert.equal(handlesSignupUrl('/v1/signup'), true)
  assert.equal(handlesSignupUrl('/v1/signup/sub_abc'), true)
  assert.equal(handlesSignupUrl('/'), false)
  assert.equal(handlesSignupUrl('/data/subscription-catalog.json'), false)
  assert.equal(handlesSignupUrl('/index.html'), false)
  // a prefix is not a route: /v1/signups must not be swallowed by /v1/signup
  assert.equal(handlesSignupUrl('/v1/signups'), false)
  assert.equal(handlesSignupUrl(undefined), false)
})

test('serve() answers serveDist\'s question synchronously', async (t) => {
  const files = workspace(t)
  const endpoint = createSubscribeEndpoint({ ...files, provider: fakeProvider(), siteOrigin: 'http://127.0.0.1:4600' })
  // a plain object stands in for a response: declining must not touch it at all
  const untouched = {}
  assert.equal(endpoint.serve('/index.html', {}, untouched), false)
  assert.deepEqual(untouched, {})
})

// ---------------------------------------------------------------------------
// The defect itself
// ---------------------------------------------------------------------------

test('a signup POST is answered by the service, not by the app shell', async (t) => {
  const files = workspace(t)
  const provider = fakeProvider()
  const endpoint = createSubscribeEndpoint({ ...files, provider, siteOrigin: 'http://127.0.0.1:4600' })
  const origin = await site(t, endpoint)

  const reply = await post(origin, GOOD)
  assert.match(reply.type, /application\/json/)
  assert.doesNotMatch(reply.text, /<!doctype html|<html/i)
  assert.equal(reply.status, 200)
  assert.equal(reply.body.ok, true)
  assert.equal(reply.body.state, 'checkout')
  assert.match(reply.body.checkoutUrl, /cs_test_/)
  assert.equal(provider.seen.length, 1)
})

test('an unrelated path still reaches the app shell', async (t) => {
  const files = workspace(t)
  const endpoint = createSubscribeEndpoint({ ...files, provider: fakeProvider(), siteOrigin: 'http://127.0.0.1:4600' })
  const origin = await site(t, endpoint)
  const response = await fetch(`${origin}/#/subscribe`)
  assert.match(response.headers.get('content-type') || '', /text\/html/)
  assert.match(await response.text(), /the app shell/)
})

test('the signup a POST created can be read back by id', async (t) => {
  const files = workspace(t)
  const endpoint = createSubscribeEndpoint({ ...files, provider: fakeProvider(), siteOrigin: 'http://127.0.0.1:4600' })
  const origin = await site(t, endpoint)

  const created = await post(origin, GOOD)
  const response = await fetch(`${origin}${SIGNUP_PATH}/${created.body.signupId}`, { cache: 'no-store' })
  const read = await response.json()
  assert.match(response.headers.get('content-type') || '', /application\/json/)
  assert.equal(read.ok, true)
  assert.equal(read.checkoutUrl, created.body.checkoutUrl)
})

test('a made-up signup id is refused in JSON rather than honoured', async (t) => {
  const files = workspace(t)
  const endpoint = createSubscribeEndpoint({ ...files, provider: fakeProvider(), siteOrigin: 'http://127.0.0.1:4600' })
  const origin = await site(t, endpoint)
  const read = await (await fetch(`${origin}${SIGNUP_PATH}/sub_inventedbyavisitor`)).json()
  assert.equal(read.ok, false)
  assert.equal(read.state, 'refused')
})

test('an unreadable body is a refusal, not a web page', async (t) => {
  const files = workspace(t)
  const endpoint = createSubscribeEndpoint({ ...files, provider: fakeProvider(), siteOrigin: 'http://127.0.0.1:4600' })
  const origin = await site(t, endpoint)
  const reply = await post(origin, '{')
  assert.match(reply.type, /application\/json/)
  assert.equal(reply.body.ok, false)
  assert.equal(reply.body.state, 'refused')
})

// ---------------------------------------------------------------------------
// A copy that is not set up to take money says so, in JSON, without a path
// ---------------------------------------------------------------------------

test('no price map is a JSON refusal, and the page is not told it is offline', async (t) => {
  const files = workspace(t, { prices: null })
  const endpoint = createSubscribeEndpoint({ ...files, provider: fakeProvider(), siteOrigin: 'http://127.0.0.1:4600' })
  const origin = await site(t, endpoint)
  const reply = await post(origin, GOOD)
  assert.equal(reply.status, 503)
  assert.match(reply.type, /application\/json/)
  assert.equal(reply.body.ok, false)
  // `unavailable` is a state src/subscription-signup.js knows; `offline` is what
  // the page invented when it could not parse an HTML reply
  assert.equal(reply.body.state, 'unavailable')
})

test('no refusal from the endpoint names a file on this computer', async (t) => {
  const files = workspace(t, { prices: null })
  const endpoint = createSubscribeEndpoint({ ...files, provider: fakeProvider(), siteOrigin: 'http://127.0.0.1:4600' })
  const origin = await site(t, endpoint)
  const reply = await post(origin, GOOD)
  assert.doesNotMatch(reply.text, /[A-Za-z]:[\\/]/)
  assert.ok(!reply.text.includes(files.pricesFile))
  assert.ok(!reply.text.includes(tmpdir()))
})

test('withoutPaths removes a path wherever it appears and keeps the sentence', () => {
  assert.equal(
    withoutPaths('no provider price map at C:\\Users\\someone\\AppData\\prices.json. Nothing was started.'),
    'no provider price map at a file this copy keeps for itself. Nothing was started.')
  assert.equal(
    withoutPaths('could not read /home/someone/.config/prices.json here'),
    'could not read a file this copy keeps for itself here')
  assert.equal(
    withoutPaths('could not read /prices.json here'),
    'could not read a file this copy keeps for itself here')
  assert.doesNotMatch(withoutPaths('read \\\\fileserver\\share\\prices.json'), /fileserver/)
  // a sentence with no path in it comes back untouched
  assert.equal(withoutPaths('That does not look like an email address.'), 'That does not look like an email address.')
  assert.equal(withoutPaths(''), '')
  assert.equal(withoutPaths(null), null)
})

test('a live-mode billing environment cannot produce an endpoint that charges', async (t) => {
  const files = workspace(t)
  const endpoint = createSubscribeEndpoint({
    ...files,
    siteOrigin: 'http://127.0.0.1:4600',
    env: {
      TOOLSENABLED_BILLING_MODE: 'live',
      TOOLSENABLED_BILLING_TEST_KEY: 'sk_live_shouldneverbeused',
      TOOLSENABLED_BILLING_API_BASE: 'https://api.stripe.com/v1',
    },
  })
  const origin = await site(t, endpoint)
  const reply = await post(origin, GOOD)
  assert.equal(reply.status, 503)
  assert.equal(reply.body.state, 'unavailable')
  assert.match(reply.body.reason, /only runs in 'test'/)
})

test('an unset billing environment refuses rather than defaulting to anything', async (t) => {
  const files = workspace(t)
  const endpoint = createSubscribeEndpoint({ ...files, siteOrigin: 'http://127.0.0.1:4600', env: {} })
  const origin = await site(t, endpoint)
  const reply = await post(origin, GOOD)
  assert.equal(reply.status, 503)
  assert.equal(reply.body.ok, false)
  assert.equal(reply.body.state, 'unavailable')
})

// ---------------------------------------------------------------------------
// The precomputed model: the thing that replaced reading the engine at runtime
// ---------------------------------------------------------------------------

test('the shipped model is readable and states what a paid session must carry', () => {
  const model = readSignupModel(SHIPPED_MODEL)
  assert.ok(model.REQUIRED_METADATA.tier)
  assert.ok(model.REQUIRED_METADATA.pairId)
  assert.ok(Object.values(model.TIERS).some(tier => tier.requiresLicense === true))
})

/* THE DRIFT GUARD, and the reason the model is allowed to be a committed file.
   Both artefacts are derived from the same engine tables at pack time, and
   tools/check-subscription-claims.mjs already holds the catalog to the model on
   the engine side. So the catalog is the fixed point: a model regenerated
   against a different engine, or a catalog regenerated without the model, shows
   up here as a disagreement about what is sold -- on a machine with no engine
   tree, which is where the mistake would otherwise be invisible. */
test('the shipped model and the shipped catalog describe the same plans', () => {
  const model = JSON.parse(readFileSync(SHIPPED_MODEL, 'utf8'))
  const catalog = JSON.parse(readFileSync(SHIPPED_CATALOG, 'utf8'))
  assert.deepEqual(Object.keys(model.tiers).sort(), catalog.plans.map(plan => plan.id).sort())
  for (const plan of catalog.plans) {
    const tier = model.tiers[plan.id]
    assert.equal(tier.label, plan.label, `${plan.id} label`)
    assert.equal(tier.requiresLicense, plan.requiresLicense, `${plan.id} requiresLicense`)
    assert.equal(tier.seatMinimum, plan.seatMinimum, `${plan.id} seatMinimum`)
    /* THE PRICES ARE GONE FROM THE MODEL, SO THE AGREEMENT IS ABOUT WHAT THEY
       IMPLIED. The model used to restate monthlyUsd and annualUsd from the
       catalog; the service never read the first at all and read the second only
       as `> 0`, which is how an unauthorised Team price of 299 came to ship
       inside app.asar (R1214: payments are not collected at first public
       launch). The catalog is still the fixed point, and a catalog that gains or
       loses an annual price still shows up here as a disagreement. */
    assert.equal(tier.annualOffered, Number.isFinite(plan.annualUsd) && plan.annualUsd > 0,
      `${plan.id} annualOffered`)
  }
})

/* THE BAR IS THE PAYLOAD, NOT THE SCREEN. d-bugs took the rendered catalog out
 * of the launch payload entirely ("the protection is that the bytes are not in
 * the payload", config/renderer-payload-boundary.json `withheld`), and the same
 * bar has to hold for the service's own shipped file -- which no payload guard
 * can see, because check-renderer-payload.mjs is scoped to dist/ and public/-
 * relative paths while this file is packed by `shell/**` straight into app.asar
 * and check-asar-manifest.mjs REQUIRES it to be there. So the guard is here, on
 * the bytes, and it reads the raw file rather than the parsed tiers: a price
 * added to a new field, a nested object or the metadata would otherwise pass.
 *
 * `seatMinimum` is deliberately NOT treated as a price -- it is a seat count,
 * the service reads it, and the engine/catalog disagreement about it is recorded
 * in tools/subscribe-service.mjs rather than resolved here. */
test('the shipped model states no price anywhere in its bytes', () => {
  const raw = readFileSync(SHIPPED_MODEL, 'utf8')
  const model = JSON.parse(raw)
  for (const name of ['monthlyUsd', 'annualUsd', 'priceUsd', 'amount', 'currency', 'price', 'prices']) {
    assert.equal(raw.includes(name), false,
      `mutation \`ship ${name} in the signup model\` survived: expected no price field inside the installer`)
  }
  const catalog = JSON.parse(readFileSync(SHIPPED_CATALOG, 'utf8'))
  const amounts = catalog.plans.flatMap(plan => [plan.monthlyUsd, plan.annualUsd])
    .filter(value => Number.isFinite(value) && value > 0)
  assert.ok(amounts.length > 0, 'The catalog this compares against must still state prices, or this proves nothing.')
  /* Scoped to the plan table, not the whole file: `generatedAt` is an ISO
     timestamp and "2026-08-12T19:30:53" contains the operator monthly price as a
     substring, so a whole-file digit scan reports a price that is a clock
     reading. Values are collected as LEAVES so a price nested under a new key is
     still caught, and the subtree's text is scanned as well so one written as a
     string ("299") cannot slip past a numeric comparison. */
  const leaves = value => (value && typeof value === 'object'
    ? Object.values(value).flatMap(leaves) : [value])
  const numbers = leaves(model.tiers).filter(value => Number.isFinite(value))
  const tierText = JSON.stringify(model.tiers)
  for (const amount of amounts) {
    assert.equal(numbers.includes(amount), false,
      `mutation \`write ${amount} into the signup model under another key\` survived: expected no priced amount in the payload`)
    assert.equal(new RegExp(`(^|[^0-9.])${amount}([^0-9.]|$)`).test(tierText), false,
      `mutation \`write ${amount} into the signup model as text\` survived: expected no priced amount in the payload`)
  }
  for (const tier of Object.values(model.tiers)) {
    assert.deepEqual(Object.keys(tier).sort(), ['annualOffered', 'id', 'label', 'requiresLicense', 'seatMinimum'],
      `mutation \`add a field to ${tier.id} that the service does not read\` survived: the model carries only what it reads`)
  }
})

test('the model this build reads is the one it ships beside itself', () => {
  // no argument at all: the default has to be the shipped file, or a packaged
  // build would read a model from wherever the process happened to be started
  const fromDefault = readSignupModel()
  const fromPath = readSignupModel(SHIPPED_MODEL)
  assert.deepEqual(fromDefault, fromPath)
})

test('every unusable model is a refusal, never a default', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'sub-model-'))
  t.after(() => { try { rmSync(directory, { recursive: true, force: true }) } catch { /* gone */ } })
  const file = path.join(directory, 'model.json')
  const write = value => writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), 'utf8')
  const good = JSON.parse(readFileSync(SHIPPED_MODEL, 'utf8'))

  assert.throws(() => readSignupModel(path.join(directory, 'absent.json')), SignupRefusal)

  write('{ not json')
  assert.throws(() => readSignupModel(file), /not valid JSON/)

  write({ ...good, schemaVersion: 99 })
  assert.throws(() => readSignupModel(file), /schema version/)

  write({ ...good, requiredMetadata: undefined })
  assert.throws(() => readSignupModel(file), /no required session metadata/)

  write({ ...good, requiredMetadata: { tier: 'x', pairId: '  ' } })
  assert.throws(() => readSignupModel(file), /"pairId" metadata key/)

  write({ ...good, tiers: {} })
  assert.throws(() => readSignupModel(file), /no plans/)

  // a model with only free plans has nothing to sell, and must not read as one
  // that sells everything
  write({ ...good, tiers: { community: { ...good.tiers.community } } })
  assert.throws(() => readSignupModel(file), /nothing it could sell/)

  // a tier whose key and id disagree is a model nobody can trust to name a plan
  write({ ...good, tiers: { ...good.tiers, operator: { ...good.tiers.operator, id: 'somethingelse' } } })
  assert.throws(() => readSignupModel(file), /no usable identity/)
})

test('a model with no paid plan refuses at the endpoint too, in JSON', async (t) => {
  const files = workspace(t)
  const modelFile = path.join(files.directory, 'model.json')
  const good = JSON.parse(readFileSync(SHIPPED_MODEL, 'utf8'))
  writeFileSync(modelFile, JSON.stringify({ ...good, tiers: { community: good.tiers.community } }), 'utf8')
  const endpoint = createSubscribeEndpoint({ ...files, modelFile, provider: fakeProvider(), siteOrigin: 'http://127.0.0.1:4600' })
  const origin = await site(t, endpoint)
  const reply = await post(origin, GOOD)
  assert.equal(reply.status, 503)
  assert.equal(reply.body.state, 'unavailable')
  assert.doesNotMatch(reply.text, /[A-Za-z]:[\\/]/)
})

// ---------------------------------------------------------------------------
// The origin the customer is returned to
// ---------------------------------------------------------------------------

test('the return URLs name the origin the window ended up on, resolved late', async (t) => {
  const files = workspace(t)
  const provider = fakeProvider()
  // exactly the shell's situation: the port is not known when the endpoint is built
  let origin = null
  const endpoint = createSubscribeEndpoint({ ...files, provider, siteOrigin: () => origin })
  origin = await site(t, endpoint)
  await post(origin, GOOD)
  assert.equal(provider.seen.length, 1)
  assert.ok(provider.seen[0].successUrl.startsWith(`${origin}/#/subscribe?signup=`))
  assert.ok(provider.seen[0].cancelUrl.startsWith(`${origin}/#/subscribe?signup=`))
})

test('the same attempt pressed three times creates exactly one signup', async (t) => {
  const files = workspace(t)
  const provider = fakeProvider()
  const endpoint = createSubscribeEndpoint({ ...files, provider, siteOrigin: 'http://127.0.0.1:4600' })
  const origin = await site(t, endpoint)
  const replies = []
  for (let i = 0; i < 3; i += 1) replies.push(await post(origin, GOOD))
  assert.equal(provider.seen.length, 1)
  const ids = new Set(replies.map(reply => reply.body.signupId))
  assert.equal(ids.size, 1)
  const ledger = JSON.parse(readFileSync(files.storeFile, 'utf8'))
  assert.equal(Object.keys(ledger.signups).length, 1)
})
