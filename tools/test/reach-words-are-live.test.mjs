/* A REACH TAG THAT OUTLIVED THE CODE IT DESCRIBED.
 *
 * Owner-visible defect. The Local row in Settings, This computer, read "Starts
 * from Launch controls, not from a tree" while the owner was starting Local
 * from New tree. The tag came from PROVIDER_SETUP's reach: 'dispatch', whose
 * justification was that resolveStartTier() in shell/agent-host.cjs refused
 * `local` from a tree unconditionally. By the time the owner read it, that
 * function contained `if (row.provider === 'local' && localEngine) return row`.
 * The code had moved and the tag had not.
 *
 * WHAT MADE IT INVISIBLE is worth pinning, because it is the shape of the bug
 * rather than this one sentence: the row's own `doesHere` paragraph had ALREADY
 * been corrected to say "a tree circle can use the Ollama chosen in your model
 * settings". So one row asserted both things at once, and neither half looked
 * wrong on its own. A paragraph and a tag that disagree is a defect even when
 * you cannot yet say which one is stale.
 *
 * SO THIS ASKS THREE QUESTIONS, ALL BY VALUE.
 *   1. Is every reach tag a provider uses actually defined? An undefined one
 *      renders an empty tag, which tells the reader nothing at all.
 *   2. Does any row's tag contradict its own paragraph about trees? That is
 *      the drift that reached the owner, and it is the load-bearing check.
 *   3. Is local tagged like the other engine-gated providers?
 *
 * WHAT THIS DELIBERATELY DOES NOT ASSERT, and why, because a reader will
 * wonder. I first wrote "every defined tag must be used", on the argument that
 * an unused word is dead copy, which is how `dispatch` survived its own
 * premise. That fails today: with `local` moved to 'tree' every provider is
 * 'tree', so 'not-from-tree' and 'none' are both unused. Two searches confirm
 * PROVIDER_SETUP is the only provider source and providerMarkup the only
 * reader, so they genuinely are unused vocabulary. Deleting copy for states
 * this panel may legitimately need again is not this gate's call, and a gate
 * whose only route to green is deleting someone else's vocabulary gets
 * weakened rather than obeyed. Recorded as a finding instead; question 2
 * catches the drift that actually hurt.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

/* src/this-computer-settings.js imports its own stylesheet, which node cannot
   load. Same loader shim tools/test/this-computer-settings.test.mjs already
   uses, copied rather than invented so both suites fail the same way if it
   stops working. */
register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.css')) return { url: new URL(specifier, context.parentURL).href, shortCircuit: true }
    return nextResolve(specifier, context)
  }
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)

const { PROVIDER_SETUP } = await import('../../src/first-run-needs.js')
const { REACH_WORDS } = await import('../../src/this-computer-settings.js')

test('every reach tag a provider uses is defined, so no row renders an empty tag', () => {
  for (const provider of PROVIDER_SETUP) {
    assert.ok(Object.prototype.hasOwnProperty.call(REACH_WORDS, provider.reach),
      `provider ${provider.id} carries reach "${provider.reach}", which REACH_WORDS does not define, so its row renders an empty tag`)
    assert.ok(String(REACH_WORDS[provider.reach]).trim().length > 0,
      `provider ${provider.id} renders an empty reach tag`)
  }
})

test('no row denies the tree in its tag while promising it in its paragraph', () => {
  /* Read by value, not by spelling: any tag whose words deny a tree start is
     caught, not just the one sentence that was wrong. */
  const deniesTree = text => /not from a tree|nothing here starts/i.test(text)
  const promisesTree = text => /tree circle can|from a tree/i.test(text)
  for (const provider of PROVIDER_SETUP) {
    const tag = REACH_WORDS[provider.reach] || ''
    const paragraph = provider.doesHere || ''
    if (!deniesTree(tag)) continue
    assert.ok(!promisesTree(paragraph),
      `provider ${provider.id} says "${tag}" in its tag and promises a tree start in its paragraph. One of the two is stale and a reader is told both`)
  }
})

test('local is tagged like the other engine-gated providers', () => {
  /* resolveStartTier() opens local on localEngine, the same shape as the
     claude, gemini and grok gates. The tag describes what the surface does;
     whether THIS machine carries the engine is the presence line's job. */
  const local = PROVIDER_SETUP.find(provider => provider.id === 'local')
  assert.ok(local, 'the local provider row is the reason this file exists')
  assert.equal(local.reach, 'tree')
  assert.doesNotMatch(REACH_WORDS[local.reach], /not from a tree/i)
})
