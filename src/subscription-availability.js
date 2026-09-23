/* The owner has delayed paid subscriptions. This is presentation policy, not a
 * catalogue result: the catalogue reader still validates and fails closed on
 * its own terms. Every control that would lead to that closed surface reads the
 * same enabled-plus-reason contract so none can become a live-looking dead end. */

export const SUBSCRIPTION_DISABLED_HINT = 'Subscriptions are not open yet. The product is free meanwhile and does not need a subscription to run.'

/* THERE IS NO SUBSCRIPTION CONTROL OBJECT ANY MORE, and that is the point.
 *
 * It described a disabled "Subscriptions coming soon" button, and by the time
 * the owner asked the product to stop advertising subscriptions it was rendered
 * on the home screen AND on the account page. Removing one left the other, so
 * the object is gone rather than merely unrendered: an exported, ready-made
 * control is what the next surface reaches for.
 *
 * The HINT stays. It is what a person is told if they reach the subscribe route
 * or a purchase refusal -- an answer to somebody who arrived, not an invitation
 * to arrive. Refusing honestly and advertising are different things, and only
 * one of them was ruled against. */
