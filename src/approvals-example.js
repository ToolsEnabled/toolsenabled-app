/* THE APPROVALS SCREEN'S DEMONSTRATION: which face it wears, and the words.
 *
 * Every landing view in this product labels its own example data -- home's
 * "Example, not your data" badge, metrics' demonstration face and "made-up
 * numbers" note, research's source line -- and the approvals view carried no
 * marking of any kind (found by the paid lane's walk of the vendored
 * simulation build, their commit 36010d5; reassigned to this repository by
 * legal's launch delivery, 2026-08-18). On that build the screen showed "the
 * approvals service is unavailable" instead, which on a page whose whole job
 * is showing a stranger the product reads as a broken product -- and an
 * unmarked queue anywhere is something a visitor is free to read as somebody's
 * real decisions.
 *
 * WHICH FACE, AND WHY IT IS DERIVED RATHER THAN A NEW FLAG. Approvals has no
 * switch of its own because its data is the audited queue: there is nothing
 * per-view to toggle, and inventing a flag would put a switch in Settings
 * that pretends the queue has a twin. The one state in which this screen is
 * part of a demonstration is when the whole product is showing its built-in
 * example -- which is exactly what src/data-source.js answers 'mock' for: the
 * example toggle is on, or this is a signed-out browser with no machine
 * behind it. Any real source, whether the desktop host or the computer being
 * driven over the relay, means this screen polls the live queue exactly as it
 * always has. (The `this-computer` face name below is a legacy internal token,
 * not reader-facing copy.)
 *
 * THIS MODULE IS PURE. It reads no DOM and opens no connection, so the suite
 * (tools/test/approvals-example-marking.test.mjs) exercises the face decision
 * and the example queue's shape for real. The view does the painting.
 */

import { currentDataSource, isExampleMode, onDesktop } from './data-source.js'
import { EXAMPLE_BADGE } from './comms-copy.js'

export const APPROVALS_FACES = Object.freeze(['demonstration', 'this-computer'])

/* The synchronous best answer to "where is this screen's data from". The view
 * decides its face once at mount, before anything has awaited, so this uses
 * only what can be known without asking: the example toggle, the desktop
 * shell's presence, and whatever verdict resolveDataSource() has already
 * cached. It can return null -- a public page before the first resolution --
 * and null is passed through as "not yet known" rather than rounded. */
function knownSource() {
  if (isExampleMode()) return 'mock'
  if (onDesktop()) return 'local'
  return currentDataSource()
}

/**
 * Which face the approvals screen wears right now.
 *
 * A KNOWN mock source is the only thing that puts the demonstration face on:
 * real data -- local or relayed -- and the not-yet-known null both wear the
 * legacy internal face token 'this-computer'. That token does not describe the
 * reader's location. Badging a person's real queue as an example is the one
 * direction this marking must never miss in, and a live poll that cannot reach
 * a queue reports that failure in its own words rather than dressing it as an
 * example.
 *
 * The source reader stays injectable so the suite can hold each answer still.
 */
export function approvalsFace({ source = knownSource } = {}) {
  return source() === 'mock' ? 'demonstration' : 'this-computer'
}

/* THE WORDS, shared with the screens that already say them. The badge is
 * home's exact badge text and the source line is the research page's shape,
 * because a product that labels the same state two ways teaches people to
 * read neither. */
export const APPROVALS_EXAMPLE_MARKING = Object.freeze({
  badge: EXAMPLE_BADGE,
  source: 'example data — switch off the example fleet in settings to see your own approvals',
  queueNote: 'An example queue, so you can see how requests read. Nothing here is waiting on anyone.',
  cardStatus: 'An example request, not yours. Its controls stay off, and nothing can be approved from it.',
  deadlineNote: '· an example deadline, from the example requests above',
  purchaseNote: '· example amounts; approving would record a decision, not spend',
})

/* THE EXAMPLE QUEUE. Two requests, the two kinds the live queue actually
 * carries: a purchase list whose total is bound to its lines (the invariant
 * the live screen refuses to render without) and a confirmation. Every date
 * hangs off the clock passed in, so the queue reads as current whenever it is
 * shown and a test can pin it; for one clock the value is always the same,
 * because a demonstration that invents different data on every paint reads as
 * live activity -- the exact defect the marking exists to prevent. */
const DAY_MS = 86_400_000

const iso = ms => new Date(ms).toISOString()

export function exampleOwnerPrompts(nowMs = Date.now()) {
  return Object.freeze([
    Object.freeze({
      id: 'example-purchases',
      kind: 'purchase_batch',
      title: 'An example purchase list',
      message: 'Two made-up lines, so you can see how a purchase request reads. Each line names what, where, and exactly how much.',
      createdAt: iso(nowMs - 2 * DAY_MS),
      expiresAt: iso(nowMs + 5 * DAY_MS),
      state: 'pending',
      defaultDecision: 'deny',
      currency: 'USD',
      totalCents: 11_140,
      items: Object.freeze([
        Object.freeze({
          id: 'example-line-domain',
          description: 'Example domain name, renewed for one year',
          amountCents: 1_240,
          currency: 'USD',
          merchant: 'An example registrar',
          purpose: 'Keeps the example project’s address working for another year.',
        }),
        Object.freeze({
          id: 'example-line-certificate',
          description: 'Example signing certificate, one month',
          amountCents: 9_900,
          currency: 'USD',
          merchant: 'An example certificate authority',
          purpose: 'Lets the example project sign what it ships.',
        }),
      ]),
    }),
    Object.freeze({
      id: 'example-confirmation',
      kind: 'confirmation',
      title: 'An example confirmation',
      message: 'An agent asks here before doing something it may not do on its own. This one is an example, so it asks for nothing.',
      createdAt: iso(nowMs - 1 * DAY_MS),
      expiresAt: iso(nowMs + 3 * DAY_MS),
      state: 'pending',
      defaultDecision: 'deny',
    }),
  ])
}
