// Does this copy of the product have a checkout at all?
//
// WHAT WENT WRONG, MEASURED ON THE PACKAGED BUILD.
//
// The purchase list was authored at public/data/purchase-catalog.json, which
// vite copies into dist/ and electron-builder packs into app.asar under the
// blanket "dist/**". Nobody ever decided that it should ship -- nothing in the
// renderer half of this product asks whether a file is the builder's own or the
// product's, so the question was never put and the file travelled. #/checkout
// was an unconditional stop on the navigation ring, so on a stranger's fresh
// install the builder's internal purchase list sat one click back from home:
// internal repo paths, internal request ids, his own second-person
// deliberations, and a written admission that the installer is unsigned.
//
// THE ABSENCE THAT WAS READ AS CONSENT was in the packaging: an unclassified
// file ships. The engine half of this product already refuses that shape --
// config/payload-boundary.json plus tools/check-payload-boundary.mjs fail the
// build on a payload file classified nowhere at all. The renderer half had no
// equivalent, so "nobody said" meant "send it". tools/check-renderer-payload.mjs
// is that missing half; this module is the runtime consequence of it.
//
// SO THE SURFACE IS NOT A CONSTANT ANY MORE. The list is now the operator's own
// file, read from the install's own data directory (shell/main.cjs), and the
// checkout exists only when one was really served. Default is UNAVAILABLE;
// malformed answers resolve unavailable, while transient machine failures stay
// indeterminate and do not overwrite the last state. A surface that appears
// because a probe was inconclusive is the same defect wearing a different hat.
//
// WHAT THIS IS NOT. It is not a permission check and it must never be sold as
// one. Hiding a door does not protect anything on its own; the protection is
// that the bytes are not in the payload. This decides whether the product
// OFFERS the screen, so that a copy with no list has no empty shop on its ring.
//
// THE SECOND MEASUREMENT: THE SAME PAGE SERVED FROM A PUBLIC ORIGIN. This
// renderer is vendored onto toolsenabled.ai as /app/, where there is no shell
// and no install data directory, so the probe above asked the website for
// data/purchase-catalog.json on every load and got a 404 back -- a request the
// site had no reason to see and a log line naming a file the site does not
// hold. The answer was always "unavailable", so the ring was right, but it was
// right by accident of a 404 rather than by decision. The decision is made
// here now: only a copy hosted by the desktop shell is asked at all, and the
// discriminator is the one the rest of the renderer already trusts,
// onDesktop() in src/data-source.js (the preload's getBridgeProof, which the
// site's host bridge deliberately withholds). A skipped probe resolves exactly
// like a failed one -- unavailable, settled, event dispatched -- so nothing
// downstream can tell the two apart, which is the point: "not hosted" and
// "hosted with no list" are both "there is no checkout on this copy".

import { onDesktop } from './data-source.js'

export const CHECKOUT_SURFACE_EVENT = 'mc:checkout-surface'

export const CHECKOUT_CATALOG_URL = 'data/purchase-catalog.json'

export const CHECKOUT_SURFACE_INDETERMINATE = 'CHECKOUT_SURFACE_INDETERMINATE'

const TRANSIENT_ERROR_CODES = new Set(['EMFILE', 'EAGAIN', 'EIO', 'EBUSY'])

// Fails closed, before anything has been measured and after anything has gone
// wrong. `settled` is separate on purpose: "not available yet" and "measured,
// and there is none" are different facts, and the router needs to tell them
// apart before it rewrites somebody's address bar.
let available = false
let settled = false

/** Is a checkout surface offered on this copy right now? */
export function checkoutSurfaceAvailable() {
  return available === true
}

/** Has the probe finished? False means "no answer yet", not "no". */
export function checkoutSurfaceSettled() {
  return settled === true
}

/**
 * Ask the shell whether this install has a purchase list, once.
 *
 * Resolves to a boolean for a definite answer and to a coded Error when the
 * machine could not tell. It never rejects: the caller is a fire-and-forget
 * router probe, while an indeterminate result must remain uncached/unlatched.
 */
export async function probeCheckoutSurface({
  fetchImpl = typeof fetch === 'function' ? fetch : null,
  url = CHECKOUT_CATALOG_URL,
  timeoutMs = 4000,
  dispatch = typeof window === 'undefined' ? null : window,
  hosted = onDesktop,
  ask = defaultAsk,
} = {}) {
  let answer
  try {
    // `hosted` is asked first and the fetch is never started unless it said
    // TRUE -- not truthy, and not "did not throw". A discriminator that threw
    // or returned something odd is a copy whose hosting is unknown, and a copy
    // whose hosting is unknown is not sent looking for a list on somebody
    // else's origin.
    const hosting = safe(hosted)
    answer = hosting === true ? await measure(fetchImpl, url, timeoutMs, ask) : hosting
  } catch (cause) {
    if (couldNotTell(cause)) return indeterminate(cause)
    answer = false
  }
  available = answer === true
  settled = true
  try {
    dispatch?.dispatchEvent?.(new CustomEvent(CHECKOUT_SURFACE_EVENT, { detail: { available } }))
  } catch { /* a window without CustomEvent is a test harness; the value is still set */ }
  return available
}

/** Call a predicate; transient/non-Error failures mean it could not answer. */
function safe(predicate) {
  try {
    return typeof predicate === 'function' ? predicate() === true : false
  } catch (cause) {
    if (couldNotTell(cause)) throw cause
    return false
  }
}

/* THE SHELL IS ASKED BEFORE ANYTHING IS FETCHED. A copy with no purchase list
   used to request the file on every start and get a 404 back -- an error-level
   line in the page's own log for a state that is normal, and the only error the
   app reported when it was first driven from outside (2026-09-02). The shell's
   bridge answers the same file check its route makes. A shell without the
   method, a refusal, or an odd reply leaves the fetch as the measurement, so
   an older shell behaves exactly as before. */
function defaultAsk() {
  const bridge = globalThis.window?.mcShell
  return typeof bridge?.checkoutSurface === 'function' ? bridge.checkoutSurface() : null
}

async function askShell(ask) {
  let reply
  try {
    reply = typeof ask === 'function' ? await ask() : null
  } catch {
    return null
  }
  if (!reply || reply.ok !== true || typeof reply.available !== 'boolean') return null
  return reply.available
}

async function measure(fetchImpl, url, timeoutMs, ask) {
  const asked = await askShell(ask)
  if (asked !== null) return asked
  if (typeof fetchImpl !== 'function') return false

  // A hung loopback read must not leave the ring in its "not measured yet"
  // state forever, and it must not decide the answer either -- a timeout is a
  // failure to measure, and a failure to measure is not a checkout.
  const timeout = new Promise((resolve, reject) => {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return
    setTimeout(() => reject(Object.assign(new Error('Catalogue read timed out'), { code: 'ETIMEDOUT' })), timeoutMs)
  })
  const response = await Promise.race([
    fetchImpl(url, { cache: 'no-store' }),
    timeout,
  ])
  if (!response) return false
  if (response.status === 404) return false
  if (response.ok !== true) return false
  // The shell answers a missing /data/*.json with 404 and a JSON body, so this
  // is belt and braces rather than the load-bearing check -- but an HTML body
  // arriving with a 200 is precisely how the old SPA fallback made "the file is
  // not there" look like success, and it costs one line to refuse it here too.
  const type = String(response.headers?.get?.('content-type') || '')
  return type.toLowerCase().includes('application/json')
}

function couldNotTell(cause) {
  return !(cause instanceof Error) || TRANSIENT_ERROR_CODES.has(cause.code) || cause.code === 'ETIMEDOUT'
}

function indeterminate(cause) {
  const error = new Error('Could not determine checkout visibility; this is NOT claiming the catalogue is absent.', { cause })
  error.code = CHECKOUT_SURFACE_INDETERMINATE
  return error
}

/** Test seam. Nothing in the app calls this; the probe is the only writer. */
export function __setCheckoutSurfaceForTest(nextAvailable, nextSettled = true) {
  available = nextAvailable === true
  settled = nextSettled === true
}
