'use strict'

/* THE "?" DOOR'S ONLY WAY OFF THIS MACHINE.
 *
 * src/views/guide.js and src/feedback-compose.js speak one relative path,
 * /v1/feedback, exactly the way src/views/subscribe.js speaks /v1/signup --
 * neither renderer is meant to know or care which machine actually answers
 * it. A browser tab open on toolsenabled.ai reaches the real account
 * service directly, because nginx proxies that whole prefix there (see
 * deploy/nginx.live.conf in the server repository, `location /v1/`). This
 * window is not on that origin: it is served from shellOrigin, a loopback
 * address this process picked at boot. A plain fetch('/v1/feedback') here
 * would resolve to nothing at all.
 *
 * THIS FILE IS THE MISSING HALF, and it is shaped exactly like
 * shell/subscribe-endpoint.cjs's own answer to the same problem: a request
 * this window's static file server would otherwise 404 is instead handed
 * to the ONE place in this application allowed to open a connection to the
 * internet on the person's behalf -- the main process -- which forwards it
 * to the real account service and relays back whatever it said, unchanged.
 * Renderer code never learns the account service's real address and never
 * needs to.
 *
 * WHY app.toolsenabled.ai, restated from nginx.live.conf's own comment on
 * exactly this: "app. remains an API host only", kept live for "fra's
 * native engine [which] is not a browser, so it has no Origin to send when
 * it enrols a machine. Their client therefore ASSERTS Origin:
 * https://app.toolsenabled.ai". This proxy is that same kind of caller --
 * server-to-server, no browser, no ambient cookie -- so it asserts the
 * identical Origin for the identical reason: the account service's CSRF
 * guard refuses every mutating request with no Origin, and this is the
 * origin its allowlist is documented to admit for exactly this shape of
 * client.
 *
 * WHAT THIS FILE DOES NOT DO. It carries no session, sets no cookie, and
 * reads none from the request it is given -- this window's own account
 * state (if any) never crosses into the request the account service sees.
 * It does not retry: one relayed attempt per request, because a retry
 * behind a relative fetch the renderer already retried on its own would
 * double a submission a person only meant to send once.
 */

const FEEDBACK_PATH = '/v1/feedback'

/* The account service's public API host. A plain constant, the same way
   device-claim-flow.js names ACCOUNT_PAGE_HOST = 'toolsenabled.ai': a
   stable fact about this product's own deployment, not a secret and not a
   per-install operator choice, so there is nothing here for an environment
   variable to usefully override in production. The parameter below exists
   anyway, entirely for tests -- see feedback-proxy.test.mjs, which points
   this at a loopback fixture rather than the real internet. */
const DEFAULT_BASE_URL = 'https://app.toolsenabled.ai'
const FEEDBACK_ORIGIN_HEADER = 'https://app.toolsenabled.ai'

const MAX_BODY_BYTES = 64 * 1024
const FETCH_TIMEOUT_MS = 15_000

function send(response, status, body) {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  response.end(text)
}

/* THE ONE SENTENCE FOR EVERY WAY THE REAL SERVICE COULD NOT BE REACHED.
 * DNS failure, connection refused, TLS failure, a timeout: none of that
 * text is a person's business, the same discipline smtp-mailer.js on the
 * server side already keeps for its own vendor errors -- a raw Node error
 * message can carry a hostname, a stack fragment, or a path, and none of
 * it helps somebody staring at a feedback box. src/feedback-compose.js
 * reads this same shape whether the account service explicitly refused or
 * this proxy could not reach it at all, and shows one sentence either way
 * (FEEDBACK_COPY.unavailable). */
function unavailable(response, status = 502) {
  send(response, status, {
    error: { code: 'FEEDBACK_UNAVAILABLE', message: 'The feedback service could not be reached, so nothing was sent.' },
  })
}

/** Read a bounded body. Refuses (returns null) and answers 413 past the ceiling. */
async function readBoundedBody(request, response) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      send(response, 413, {
        error: { code: 'FEEDBACK_BODY_TOO_LARGE', message: 'That was too much to send in one go, so nothing was sent.' },
      })
      request.destroy()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/**
 * @param baseUrl    the account service's origin. Defaults to the real one;
 *                   overridden only by tests.
 * @param fetchImpl  injectable fetch, defaulting to the global the main
 *                   process already has (Node's built-in fetch). Never
 *                   imported from a package -- this application ships zero
 *                   added dependencies for exactly the reason
 *                   server/src/smtp-mailer.js gives for its own choice.
 * @param timeoutMs  bounds the outbound call so a hung account service
 *                   cannot wedge this window's local server behind a
 *                   request that never answers.
 */
function createFeedbackProxy({ baseUrl = DEFAULT_BASE_URL, fetchImpl, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const runFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null)

  async function relay(method, request, response) {
    let outboundBody
    if (method === 'POST') {
      const bytes = await readBoundedBody(request, response)
      if (bytes === null) return // 413 already answered
      outboundBody = bytes
    }

    if (!runFetch) { unavailable(response); return }

    let upstream
    try {
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
      try {
        upstream = await runFetch(`${baseUrl}${FEEDBACK_PATH}`, {
          method,
          headers: method === 'POST'
            ? { 'content-type': 'application/json', origin: FEEDBACK_ORIGIN_HEADER }
            : { origin: FEEDBACK_ORIGIN_HEADER },
          body: outboundBody,
          signal: controller ? controller.signal : undefined,
        })
      } finally {
        if (timer) clearTimeout(timer)
      }
    } catch {
      unavailable(response)
      return
    }

    let text
    try {
      text = await upstream.text()
    } catch {
      unavailable(response)
      return
    }
    /* RELAYED VERBATIM. The account service already writes every one of
       these sentences for a person to read (see its own header:
       "EVERY `message` HERE CAN END UP ON A CUSTOMER'S SCREEN"), so there
       is nothing to rewrite here -- only the status and the body, carried
       through unchanged. */
    response.writeHead(upstream.status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
    })
    response.end(text)
  }

  return Object.freeze({
    handles: url => url === FEEDBACK_PATH,

    /**
     * serveDist's convention, the same one shell/subscribe-endpoint.cjs
     * uses: return true the instant this request is claimed, and let the
     * async work run behind that -- see that file's own header for why the
     * split has to be exactly this shape.
     */
    serve(url, request, response) {
      if (url !== FEEDBACK_PATH) return false
      Promise.resolve()
        .then(() => relay(request.method, request, response))
        .catch(() => {
          if (response.headersSent) { try { response.end() } catch { /* already gone */ } return }
          unavailable(response)
        })
      return true
    },
  })
}

module.exports = { FEEDBACK_PATH, DEFAULT_BASE_URL, FEEDBACK_ORIGIN_HEADER, createFeedbackProxy }
