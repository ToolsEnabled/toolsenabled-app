/* WHAT A PERSON SENDS US WHEN SOMETHING IS WRONG, AND WHERE IT NOW GOES.
 *
 * THIS USED TO BUILD A mailto: AND HAND IT TO THE PERSON'S OWN MAIL CLIENT.
 * The owner has since ruled that path must never ship (S6 lane, "the mailto
 * version must never ship") now that a route exists to receive this
 * properly: `POST /v1/feedback` on the account service
 * (toolsenabled-paid/server/src/http-service.js). That route's own header
 * answers the three worries the mailto approach existed to dodge --
 *
 *   1. A store now exists on purpose, with a retention story: every
 *      submission is written down, approved sender or not, and nothing
 *      about it is guessed at here.
 *   2. Only an OPERATOR-APPROVED sender's message is ever emailed onward,
 *      to the operator's own configured address, never to a mailbox this
 *      client invents.
 *   3. The person still sees exactly what they typed before it goes,
 *      because this composer still validates and still shows the request
 *      it is about to make -- it simply posts the message instead of
 *      building a link for a mail client to open.
 *
 * THE ROUTE'S CONTRACT, restated here because this is the one file in this
 * repository that has to match it byte for byte:
 *
 *   GET  /v1/feedback   -> 200 { available: true } whenever the backend is
 *                          up. No session, no Origin header required.
 *   POST /v1/feedback   body { message: string, email?: string }
 *                       -> 202 { received: true } on every accepted
 *                          submission, approved sender or not -- the
 *                          response never reveals which. Refusals: 400
 *                          (message empty / too long / email malformed),
 *                          403 ORIGIN_REFUSED, 429 RATE_LIMITED, each as
 *                          { error: { code, message } }.
 *
 * NO EMAIL FIELD IS OFFERED ON THIS SCREEN, deliberately, matching the
 * merged form as it stands rather than growing it. `email` is left out of
 * the request body entirely; the account service falls back to a signed-in
 * session's own address when one is present (see its route header) and
 * otherwise records the submission with no reply address. That is an
 * honest state, not a defect: a stranger who has not signed in gets exactly
 * what mailto: gave them anyway -- their words kept, with no address
 * attached unless the surface later grows one.
 */

export const FEEDBACK_ENDPOINT = '/v1/feedback'

/* Matches server/src/feedback-store.js's MESSAGE_MAX exactly. The two
   numbers have no shared source across the two repositories, so this one
   is a manual restatement -- the same trade PASSWORD_MIN and dozens of
   other cross-repo contract numbers already make in this codebase. There
   is no URL to fit inside any more (that ceiling died with the mailto:
   link), so this now states the SERVER's real limit rather than a stricter
   one invented for a transport that no longer exists. */
export const MAX_MESSAGE_CHARACTERS = 8000

export const FEEDBACK_COPY = Object.freeze({
  heading: 'Write to us about a problem',
  intro: 'This sends your message to us directly. We store every message; some go straight to an inbox we read and the rest wait for us to look.',
  includeBuild: 'Include which version this is',
  buildWhy: 'Two lines saying which build you are on. It is usually the difference between a report we can act on and one we cannot.',
  send: 'Send',
  sending: 'Sending…',
  empty: 'Write what happened first, then press Send.',
  tooLong: `That is longer than we can take in one message. Keep it under ${MAX_MESSAGE_CHARACTERS} characters.`,
  sent: 'Sent. Thank you — we have it.',
  unavailable: 'This is not reachable right now, so nothing was sent. Nothing you typed was lost; try again in a while.',
  rateLimited: 'That is a lot of messages in a short time. Wait a few minutes, then try again.',
  failed: 'That could not be sent, so nothing went through. Try again in a moment.',
})

const trimmed = value => (typeof value === 'string' ? value.trim() : '')

/**
 * Validate and shape one submission into the exact body POST /v1/feedback
 * takes. Returned rather than sent, so a caller can show the person what
 * will go before it does -- the same reason the mailto version returned its
 * body instead of only a URL.
 */
export function composeFeedback({ message, includeBuild = false, build = null } = {}) {
  const body = trimmed(message)
  if (!body) return { ok: false, code: 'FEEDBACK_EMPTY', why: FEEDBACK_COPY.empty }
  if (body.length > MAX_MESSAGE_CHARACTERS) {
    return { ok: false, code: 'FEEDBACK_TOO_LONG', why: FEEDBACK_COPY.tooLong, length: body.length }
  }

  /* The build block is appended, never interleaved, and it is labelled --
     unchanged from the mailto version. A person who does not want to send
     it can delete two lines and the rest still reads. */
  let full = body
  if (includeBuild && build && typeof build === 'object') {
    const version = trimmed(build.version)
    const commit = trimmed(build.commit)
    const lines = []
    if (version) lines.push('Version: ' + version)
    if (commit) lines.push('Build: ' + commit)
    if (lines.length) full = body + '\n\n--\n' + lines.join('\n')
  }

  return { ok: true, body: { message: full } }
}

/** The one shape every outcome below is normalized into. */
function outcome(ok, code, why, extra = {}) {
  return Object.freeze({ ok, code, why, ...extra })
}

/**
 * Ask the backend whether it is there at all -- what the "?" door's render
 * gates on. `true` only for a live process answering `available: true`;
 * anything else -- a refusal, a malformed reply, a network error, a fetch
 * that is not even offered -- is `false`.
 *
 * DELIBERATELY TWO-VALUED, NOT THE THREE-VALUED true/false/undefined
 * src/capability-probes.js uses for "could not check" elsewhere in this
 * product. That convention exists so a control can stay OFFERED, disabled,
 * with a reason, when a probe cannot run. The owner's ruling for this door
 * specifically forbids that middle state: "door absent when the backend
 * doesn't answer, never a dead button." A door that cannot be probed has to
 * behave exactly like one that was probed and answered no.
 */
export async function probeFeedbackAvailable({ fetchImpl } = {}) {
  const runFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null)
  if (!runFetch) return false
  try {
    const response = await runFetch(FEEDBACK_ENDPOINT, { method: 'GET', cache: 'no-store' })
    if (!response || response.ok !== true) return false
    const payload = await response.json().catch(() => null)
    return Boolean(payload && payload.available === true)
  } catch {
    return false
  }
}

/**
 * Compose, then send. Validates first -- exactly as composeFeedback always
 * did -- so a message that will be refused never reaches the network at
 * all, and the fetch itself is never awaited by a caller who does not
 * intend to send anything.
 *
 * EVERY BRANCH RETURNS THE SAME SHAPE: { ok, code, why }. A caller that
 * only ever reads `why` cannot be broken by a branch it does not know
 * about, which is the same discipline src/account-state.js's
 * readActionResult keeps for the shell's account verbs.
 */
export async function submitFeedback({ message, includeBuild = false, build = null, fetchImpl } = {}) {
  const composed = composeFeedback({ message, includeBuild, build })
  if (!composed.ok) return outcome(false, composed.code, composed.why)

  const runFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null)
  if (!runFetch) return outcome(false, 'FEEDBACK_UNAVAILABLE', FEEDBACK_COPY.unavailable)

  let response
  try {
    response = await runFetch(FEEDBACK_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(composed.body),
    })
  } catch {
    /* No route to the backend at all -- offline, the shell's local proxy
       could not reach the real service, a browser tab served with no /v1/
       behind it. Same sentence as an explicit "not available" answer: the
       person does not need to know which of the two happened, only that
       nothing was sent. */
    return outcome(false, 'FEEDBACK_UNAVAILABLE', FEEDBACK_COPY.unavailable)
  }

  let payload = null
  try { payload = await response.json() } catch { payload = null }

  if (response.status === 202 && payload && payload.received === true) {
    return outcome(true, null, FEEDBACK_COPY.sent)
  }
  if (response.status === 429) {
    return outcome(false, 'FEEDBACK_RATE_LIMITED', FEEDBACK_COPY.rateLimited)
  }
  /* A NAMED SERVER REFUSAL IS SHOWN AS ITSELF, the same rule
     src/views/guide.js's sign-in refusal already follows: a refusal that
     carries its own sentence is more useful than a generic one written
     here that does not know why. Falls back to the generic failure only
     when the server said nothing legible. */
  const serverMessage = payload && payload.error && typeof payload.error.message === 'string'
    ? payload.error.message
    : ''
  const serverCode = payload && payload.error && typeof payload.error.code === 'string'
    ? payload.error.code
    : 'FEEDBACK_REFUSED'
  return outcome(false, serverCode, serverMessage || FEEDBACK_COPY.failed)
}
