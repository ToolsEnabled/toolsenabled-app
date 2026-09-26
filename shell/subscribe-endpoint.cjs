'use strict'

/* THE THING THAT ANSWERS AT /v1/signup.
 *
 * ------------------------------------------------------------------------
 * THE DEFECT THIS CLOSES
 *
 * src/views/subscribe.js posts to /v1/signup and reads the reply as JSON. The
 * shell's file server handled two special routes and then fell through to the
 * SPA fallback -- index.html, status 200, content-type text/html -- for
 * everything else. So the signup POST got a web page where a decision was
 * expected, `response.json()` threw, and src/subscription-signup.js classified
 * the unparseable reply as `offline`. A customer with a perfectly good network
 * connection, pressing the button that takes their money, was told their device
 * was offline. Nothing was wrong with their device; there was no server.
 *
 * ------------------------------------------------------------------------
 * WHY IT IS SHAPED LIKE THIS
 *
 * serveDist() composes handlers that are SYNCHRONOUS and return a boolean --
 * "I took this request" or "I did not" -- and the signup handler is async. So
 * `serve()` decides synchronously, returns true, and lets the async work run
 * under a catch that always ends the response. Exactly the pattern
 * serveOwnerPurchaseList already uses next to it, for the same reason.
 *
 * EVERYTHING IS BUILT PER REQUEST, and that is deliberate. The price map and
 * the billing environment are per-deployment, they can appear or change while
 * the app is running, and a service constructed once at startup would hold the
 * refusal it was born with for the life of the window -- so a machine that was
 * configured after launch would keep reporting that it cannot sell anything.
 * The reads are two small local files on a surface nobody hits in a loop.
 *
 * NO FILESYSTEM PATH LEAVES THIS MODULE. The service's own refusals name the
 * file they could not find, which is right for an operator reading a terminal
 * and wrong for a stranger reading a payment page -- an absolute path under
 * userData carries the person's account name. withoutPaths() is applied to
 * every reason on the way out, so this holds for refusals raised anywhere
 * beneath it, including ones added later.
 */

const path = require('node:path')

const {
  SignupRefusal,
  SignupStore,
  createCheckoutProvider,
  createHttpHandler,
  createSignupService,
  readPriceMap,
  readSignupModel,
} = require('./subscribe-service.cjs')

const SIGNUP_PATH = '/v1/signup'

/** The two files an install keeps its own signup state and prices in. */
const STORE_FILE_NAME = 'subscription-signups.json'
const PRICES_FILE_NAME = 'subscription-prices.json'

/* A drive letter path, a POSIX absolute path, or a UNC share. Deliberately
   greedy about what counts: a reason that loses a little specificity is a much
   smaller problem than one that prints where a person's home directory is. */
const PATH_SHAPED = /(?:[A-Za-z]:[\\/]|\\\\[^\s\\]+\\|(?:^|(?<=[\s(]))\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+)[^\s,;)"']*/g

/**
 * The same sentence with any filesystem path replaced by a description of it.
 *
 * Exported because the suite asserts the property directly: it is easier to
 * prove "no reason this endpoint emits contains a path" against the function
 * than against every branch that reaches it.
 */
function withoutPaths(text) {
  if (typeof text !== 'string' || !text) return text
  return text.replace(PATH_SHAPED, (match) => {
    /* A path at the end of a sentence swallows the full stop -- `prices.json.`
       is all path-shaped -- and a refusal that trails off mid-thought reads as
       a truncated message rather than as an answer. Whatever sentence
       punctuation the match ended on is put back. */
    const tail = match.match(/[.:!?]+$/)
    return `a file this copy keeps for itself${tail ? tail[0] : ''}`
  })
}

/** Does this URL belong to the signup service at all? */
function handlesSignupUrl(url) {
  if (typeof url !== 'string') return false
  return url === SIGNUP_PATH || url.startsWith(`${SIGNUP_PATH}/`)
}

/**
 * Build the endpoint.
 *
 * `dataDirectory` is where this install keeps its own state -- userData in the
 * application, a temporary directory in a harness. `siteOrigin` may be a
 * function, because the shell does not know its own origin until the port scan
 * has finished and the success URL has to name the origin the visitor is on.
 */
function createSubscribeEndpoint({
  dataDirectory,
  siteOrigin,
  modelFile,
  storeFile,
  pricesFile,
  provider,
  env = process.env,
  now,
} = {}) {
  if (typeof dataDirectory !== 'string' || !dataDirectory.trim()) {
    if (!storeFile || !pricesFile) {
      throw new TypeError('createSubscribeEndpoint needs a dataDirectory, or an explicit storeFile and pricesFile.')
    }
  }
  const store = storeFile || path.join(dataDirectory, STORE_FILE_NAME)
  const prices = pricesFile || path.join(dataDirectory, PRICES_FILE_NAME)

  /* The provider is pinned to Stripe test mode by createCheckoutProvider, which
     refuses at construction on anything else. It stays pinned: Paddle is the
     launch provider and a different lane owns that move. Nothing here can be
     configured into a live charge. */
  const buildProvider = () => (provider || createCheckoutProvider({
    mode: env.TOOLSENABLED_BILLING_MODE,
    secretKey: env.TOOLSENABLED_BILLING_TEST_KEY,
    apiBase: env.TOOLSENABLED_BILLING_API_BASE,
  }))

  function buildService() {
    return createSignupService({
      engine: readSignupModel(modelFile),
      priceMap: readPriceMap(prices),
      provider: buildProvider(),
      store: new SignupStore(store),
      siteOrigin,
      now,
    })
  }

  /** Answer a request this endpoint could not even build a service for. */
  function refuse(response, error) {
    const refusal = error instanceof SignupRefusal
      ? { status: error.status, state: error.state, reason: error.reason }
      : { status: 503, state: 'unavailable', reason: 'This copy could not start a signup, so nothing was started.' }
    const body = JSON.stringify({ ok: false, state: refusal.state, reason: withoutPaths(refusal.reason) })
    response.writeHead(refusal.status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    response.end(body)
  }

  /* The reply is rewritten rather than passed through, for the reason at the
     head of this file: a refusal raised deep inside the service may name a
     file. It is JSON either way, so the page's own state machine is unaffected. */
  function guardedResponse(response) {
    const writeHead = response.writeHead.bind(response)
    const end = response.end.bind(response)
    let json = false
    response.writeHead = (status, ...rest) => {
      const headers = rest.length && typeof rest[rest.length - 1] === 'object' ? rest[rest.length - 1] : null
      const type = headers ? String(headers['content-type'] || headers['Content-Type'] || '') : ''
      json = type.includes('application/json')
      return writeHead(status, ...rest)
    }
    response.end = (chunk, ...rest) => {
      if (!json || typeof chunk !== 'string') return end(chunk, ...rest)
      let parsed
      try { parsed = JSON.parse(chunk) } catch { return end(chunk, ...rest) }
      if (parsed && typeof parsed === 'object' && typeof parsed.reason === 'string') {
        parsed.reason = withoutPaths(parsed.reason)
        return end(JSON.stringify(parsed), ...rest)
      }
      return end(chunk, ...rest)
    }
    return response
  }

  return {
    handles: handlesSignupUrl,
    storeFile: store,
    pricesFile: prices,

    /**
     * serveDist's convention: return true when this request has been taken.
     *
     * `url` is the pathname the caller has already split the query off, so the
     * decision is made on the route and never on a query string.
     */
    serve(url, request, response) {
      if (!handlesSignupUrl(url)) return false
      let handler
      try {
        handler = createHttpHandler(buildService())
      } catch (error) {
        refuse(response, error)
        return true
      }
      Promise.resolve()
        .then(() => handler(request, guardedResponse(response)))
        .catch(error => {
          if (response.headersSent) { try { response.end() } catch { /* already gone */ } return }
          refuse(response, error)
        })
      return true
    },
  }
}

module.exports = {
  PRICES_FILE_NAME,
  SIGNUP_PATH,
  STORE_FILE_NAME,
  createSubscribeEndpoint,
  handlesSignupUrl,
  withoutPaths,
}
