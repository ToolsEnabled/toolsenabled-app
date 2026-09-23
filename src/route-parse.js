/* THE HASH-TO-STOP TABLE, AS A FUNCTION OF THE HASH AND NOTHING ELSE.
 *
 * WHY IT IS A MODULE OF ITS OWN. This table lived inside src/main.js's parse(),
 * which no node test can reach: importing main.js imports every view and every
 * stylesheet and then mounts the application into a document. So the one thing
 * this table can get wrong -- an address resolving to the wrong stop -- could
 * only ever be caught by driving a browser, and the defect it can get wrong is
 * expensive. An address this table does not recognise falls to home, and a door
 * that silently throws the reader back where they started is worse than a door
 * that is missing: the reader presses it twice and then stops believing the
 * screen. `#/guide` is exactly that door, on six screens.
 *
 * IT IS PURE, AND THAT IS THE POINT: no location, no localStorage, no history.
 * The ledger stop is the only one with a side effect -- it consumes the tab a
 * link chose, once, and rewrites the address so a later read does not re-apply
 * it -- so this function returns what that decision NEEDS (`tab`, and the query
 * that survives removing it) and src/main.js stays the only place that writes.
 */

import { GUIDE_HREF } from './first-run-needs.js'

/** The ledger's four lists, as `?tab=` may name them. */
export const LEDGER_TABS = Object.freeze(['r', 't', 'a', 'p'])

/* THE `#/guide` ALIAS IS READ OFF THE DOOR RATHER THAN SPELLED AGAIN.
 *
 * The page this address used to open is a section of Settings now, and
 * every screen that used to link to that page links to the row through
 * GUIDE_HREF. The old address stays routed, because it is in older refusal
 * sentences, in the shell's route lists and in whatever a reader wrote down --
 * and it must land on the same row the doors land on. Deriving the query from
 * the constant is what makes that true by construction: move the row and the
 * alias moves with it, with nothing to remember. */
const GUIDE_ALIAS_QUERY = GUIDE_HREF.includes('?') ? GUIDE_HREF.slice(GUIDE_HREF.indexOf('?') + 1) : ''

/**
 * Resolve one hash to the stop it names.
 *
 * @param {string} hash the raw `location.hash`, with or without its `#/`.
 * @returns {{name: string} & Record<string, unknown>} the stop, never null:
 *   an address this copy does not know is `home`, which is what the router has
 *   always done with one.
 */
export function parseRoute(hash) {
  const raw = typeof hash === 'string' && hash.length > 0 ? hash : '#/'
  /* A hash can carry a query. Splitting the path off before the segments are
     read is not a new behaviour for the existing routes -- none of them has
     ever been reachable WITH a query, and `#/ledger?x=1` used to parse as a
     stop literally named "ledger?x=1" and silently resolve to home. The
     subscribe surface needs one (the payment provider returns the visitor to
     `#/subscribe?signup=<id>`), so the router learns to read one, once, here. */
  const [hashPath, hashQuery = ''] = raw.replace(/^#\//, '').split('?')
  const parts = hashPath.split('/').filter(Boolean)
  const query = new URLSearchParams(hashQuery)
  if (parts[0] === 'computers') return { name: 'computers', comp: parts[1] || null }
  /* T302: THE #/agent DRILL-IN IS RETIRED, DELIBERATELY LEFT UNMATCHED HERE
     rather than routed anywhere. The owner's complaint was the page itself
     surfacing with no way in that made sense to them ("it got pulled up,
     nothing should reach it") -- src/views/agent.js still exists (its ~20
     source-text witness tests still read it, and removing the file itself is
     a separate, deliberate cleanup), but no hash may resolve to it any more.
     An unmatched hash falls through to the `home` stop at the end of this
     function, the same honest landing every other unrecognised address gets. */
  if (parts[0] === 'metrics') return { name: 'metrics' }
  if (parts[0] === 'research') return { name: 'research' }
  if (parts[0] === 'comms') return { name: 'comms' }
  if (parts[0] === 'ledger' || parts[0] === 'approvals') {
    const asked = parts[0] === 'approvals' ? 'p' : query.get('tab')
    const tab = LEDGER_TABS.includes(asked) ? asked : null
    if (tab) query.delete('tab')
    return { name: 'ledger', tab, rest: tab ? query.toString() : '' }
  }
  if (parts[0] === 'checkout') return { name: 'checkout' }
  /* THE QUERY TRAVELS FOR SETTINGS TOO, and it is the difference between a link
     that names a switch and a link that drops a person at the top of a page
     with 219 controls on it. `?setting=<id>` is read by src/views/settings.js,
     which opens the section that holds it and scrolls to it. Same mechanism the
     subscribe route already uses; nothing else about this stop changes, and a
     plain `#/settings` still lands where it always did. */
  if (parts[0] === 'settings') return { name: 'settings', query }
  /* THE VAULT IS ITS OWN STOP, at its own address, because the owner asked for
     one three times ("its supposed to have its own page like settings and
     ledger does") while the surface existed only as a row inside Settings. */
  if (parts[0] === 'vault') return { name: 'vault' }
  if (parts[0] === 'tools') return { name: 'tools' }
  if (parts[0] === 'setup') return { name: 'setup' }
  if (parts[0] === 'account') return { name: 'account' }
  /* THE OLD ADDRESS OF THE PAGE THAT IS NOW A SECTION OF SETTINGS. It stays
     routed rather than being dropped, and it resolves to the row rather than to
     home, for the reason it was ever a stop: six screens link to it, an
     unrouted `#/guide` resolves to home, and that turns every one of those
     doors into a control that silently throws the reader back where they
     started -- the dead end those doors exist to close, wearing a link. The
     shell's own route lists keep `/guide` for the same reason. */
  if (parts[0] === 'guide') return { name: 'settings', query: new URLSearchParams(GUIDE_ALIAS_QUERY) }
  /* `pricing` is what a stranger types; `subscribe` is the durable route name.
     Both reach the coming-soon surface rather than turning the address into a
     confusing jump home. */
  if (parts[0] === 'subscribe' || parts[0] === 'pricing') return { name: 'subscribe', query }
  return { name: 'home' }
}
