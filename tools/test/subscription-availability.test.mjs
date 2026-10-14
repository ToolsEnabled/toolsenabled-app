import assert from 'node:assert/strict'
import test from 'node:test'

import * as availability from '../../src/subscription-availability.js'
import { SUBSCRIPTION_DISABLED_HINT } from '../../src/subscription-availability.js'

test('the module exports no ready-made subscription control', async () => {
  /* THIS TEST GUARDS THE OPPOSITE OF WHAT IT USED TO.
   *
   * It used to assert that SUBSCRIPTION_CONTROL was disabled, carried its
   * reason, kept the label "Subscriptions coming soon" and pointed at
   * #/subscribe. Every one of those assertions was correct about a control that
   * should not have existed: the owner asked, 2026-08-26, that the product stop
   * advertising subscriptions, and an exported ready-made control is what the
   * next surface reaches for. views/home.js dropped its copy on that ruling and
   * the account page kept one, which is precisely how the advert survived.
   *
   * So the pin is inverted rather than deleted. Mutation watched: re-export any
   * object under this name and this turns red. */
  assert.equal(availability.SUBSCRIPTION_CONTROL, undefined,
    'a ready-made subscription control is exported again; that is the object every advertising surface was built from')
  assert.ok(!Object.keys(availability).some(name => /CONTROL|BUTTON|DOOR|LINK/i.test(name)),
    `this module exports a control-shaped name again: ${Object.keys(availability).join(', ')}`)
})

test('the reason a person is given still explains that the product is free meanwhile', () => {
  /* The HINT stays and must keep saying this. It is what somebody is told when
     they REACH the subscribe route or a purchase refusal -- an answer to a
     person who arrived, not an invitation to arrive. Refusing honestly and
     advertising are different things and only one was ruled against.

     Mutation watched: replace the hint with
     "Subscriptions are not open yet. Buy a subscription to use the product." */
  assert.match(SUBSCRIPTION_DISABLED_HINT, /subscriptions? (?:are|is) not open/i,
    'the reason must say plainly that subscriptions are not open')
  assert.match(SUBSCRIPTION_DISABLED_HINT, /free[^.]*does not need a subscription/i,
    'the reason must say the product remains free without a subscription, or an unavailable reading becomes a paywall claim')
})
