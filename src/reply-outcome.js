/* DID THE THING ACTUALLY HAPPEN?
 *
 * Four shell verbs answer { ok: true } alongside a field saying the action was a
 * no-op, because nothing needed doing or nothing could be found to do:
 *
 *   product-account.cjs  signOutEverywhere -> { ok: true, revoked: false }
 *   main.cjs             googleCancel      -> { ok: true, cancelled: false }
 *   provider-login.cjs   loginStop         -> { ok: true, stopped: false }
 *   account-registry.cjs accountRemove     -> { ok: true, removed: false }
 *
 * Every renderer branched on `ok` alone, so all four printed a success sentence
 * describing something that did not occur. The sharpest was "Signed out
 * everywhere. Any saved sign-in taken from this computer earlier is now
 * refused." on { ok: true, revoked: false } -- a person is told other sessions
 * are dead when no epoch was bumped and every copied sign-in still works.
 *
 * `ok` MEANS "NOTHING WENT WRONG". IT DOES NOT MEAN "IT HAPPENED." Those are
 * different facts and the verbs already report both; only the readers collapsed
 * them. This module is the one place that distinction is written down, so a
 * fifth verb of the same shape has somewhere to be read from rather than a
 * fourth place to be forgotten.
 *
 * It deliberately does NOT compose the sentence. The four cases mean different
 * things to a person -- already signed out, no sign-in was in flight, nothing
 * was installed to stop, no such account -- and one shared sentence for all four
 * would be the vaguer kind of lie. This classifies; the caller says what is true
 * of its own case.
 */

/** True only when the reply says the action succeeded AND took effect.
 *  A reply with no such field is treated as having taken effect: most verbs do
 *  not report one, and inventing a refusal for them would break every working
 *  control to guard four. */
export function tookEffect(reply, field) {
  if (!reply || reply.ok !== true) return false
  if (!field || !Object.prototype.hasOwnProperty.call(reply, field)) return true
  return reply[field] !== false
}

/** True when the call succeeded but explicitly did nothing. This is the state
 *  every caller here was silently treating as success. */
export function succeededWithoutEffect(reply, field) {
  if (!reply || reply.ok !== true) return false
  if (!field || !Object.prototype.hasOwnProperty.call(reply, field)) return false
  return reply[field] === false
}
