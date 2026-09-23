import assert from 'node:assert/strict'
import test from 'node:test'

import { guidanceMarkup, withheldMarkup } from '../../src/guided-step.js'

test('guidanceMarkup renders the declared setting trade-off and escapes caller-provided text', () => {
  const markup = guidanceMarkup('write_dispatch', {
    probe: () => false,
    summary: 'Explain <this> & "that"',
  })

  assert.ok(
    markup.includes('data-guided-declared="true"') &&
      markup.includes('What it lets happen') && markup.includes('What it risks') &&
      markup.includes('What doing this would let you do') && markup.includes('What it costs you') &&
      markup.includes('&lt;this&gt;') && markup.includes('&amp;') && markup.includes('&quot;that&quot;'),
    'declared guidance must show both trade-offs and safely render caller-provided summary text',
  )
})

test('guidanceMarkup preserves could-not-read as unknown rather than a definite answer', () => {
  const markup = guidanceMarkup('write_dispatch', { probe: () => ({ ok: false }) })

  assert.ok(
    markup.includes('data-guided-state="unknown"') && /could not check/i.test(markup) &&
      /will not tell you either way/i.test(markup) && markup.includes('guided-steps'),
    'a could-not-read result must remain unknown, say so, and preserve the optional remedy',
  )
})

test('guidanceMarkup reports an undeclared caller id instead of silently implying safety', () => {
  const markup = guidanceMarkup('future_<setting>', { summary: 'Risk <details>' })

  assert.ok(
    markup.includes('data-guided-declared="false"') &&
      /not.*(statement|declared|written)|no .*statement/i.test(markup) &&
      markup.includes('future_&lt;setting&gt;') && markup.includes('Risk &lt;details&gt;'),
    'an unknown subject must report missing guidance and safely render caller-provided text',
  )
})

test('withheldMarkup explains the real disabled control without offering to act for the user', () => {
  const markup = withheldMarkup('write_agent-session', {
    label: 'Start <agent>',
    reason: 'Off because "Observe" & review',
    tone: 'is-quiet" data-injected="yes',
  })

  assert.ok(
    markup.includes('data-guided-declared="true"') &&
      markup.includes('What turning it on would let you do') && markup.includes('What it would risk') &&
      /do not have to|optional/i.test(markup) &&
      markup.includes('Start &lt;agent&gt;') && markup.includes('&quot;Observe&quot; &amp; review') &&
      markup.includes('is-quiet&quot; data-injected=&quot;yes'),
    'withheld guidance must show both trade-offs, remain optional, and safely render caller text',
  )
})
