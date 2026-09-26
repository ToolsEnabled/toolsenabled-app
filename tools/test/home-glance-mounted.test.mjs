import test from 'node:test'
import assert from 'node:assert/strict'
import { homeFixture } from './helpers/home-additions-world.mjs'

// The example's live head moves every 45 s; at this instant one run is in
// flight and earlier ones were refused, so the example shows work and waiting.
const FIXED_NOW = 39_780_027 * 45_000 + 10_000

test('mounted default example Home has one current attention answer in the strip and agent panel', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW })
  const f = await homeFixture(t, { source: 'mock' })
  const view = await f.mount()
  const summary = view.el.querySelector('[data-agents-summary]').textContent
  const needed = Number(summary.match(/(\d+)\s*needs? you/)?.[1] || 0)
  assert.ok(needed > 0, 'the example has agents waiting on the person')
  assert.equal(Number(view.el.querySelector('[data-glance="attention"]').textContent), needed)
  // T1481: the strip's Working agrees with the panel's 'N working'.
  const working = Number(summary.match(/(\d+)\s*working/)?.[1] || 0)
  assert.ok(working > 0, 'the example shows an agent at work')
  assert.equal(Number(view.el.querySelector('[data-glance="working"]').textContent), working)
  const runs = Number(view.el.querySelector('[data-glance="runs"]').textContent)
  const agents = Number(view.el.querySelector('[data-glance="agents"]').textContent)
  assert.ok(runs > agents, 'historical runs remain counted while current attention is per agent')
  assert.deepEqual(f.effects, { start: 0, send: 0 })
})
