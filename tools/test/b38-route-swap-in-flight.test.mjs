/* B38 (1.0.48 soak, tree-child-codex): a helper started while the Computers
 * page re-renders is left "not started yet".
 *
 * Every failing agent.spawn had the same shape: Computers mounted twice within
 * half a second. render() hands the swap to the browser's view transition,
 * which calls it back a frame later; drainTreeNodeCommands re-drains every
 * 120 ms and, seeing the old page still current, rendered again. The browser
 * skips the first transition but still calls its swap, then calls the second,
 * so the page that had just taken the agent's request was retired under it.
 *
 * This runs the production render() out of src/main.js against a browser
 * stand-in that keeps the real ordering: a transition's swap waits for the next
 * frame, and a skipped transition's swap is still called.
 *
 *   node --test tools/test/b38-route-swap-in-flight.test.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const MAIN = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8')
/* Absent before the fix; the router then runs without a latch, which is the
   behaviour this file exists to refuse. */
const latch = await import('../../src/route-swap-latch.js').catch(() => null)
const inertLatch = () => ({ begin: () => null, end() {}, covers: () => false })

function renderSource() {
  const start = MAIN.indexOf('function render() {')
  const end = MAIN.indexOf('\n}\n', start)
  assert.ok(start >= 0 && end > start, 'src/main.js must declare render()')
  return MAIN.slice(start, end + 2)
}

function routerFixture({ clock = { value: 0 } } = {}) {
  const location = { hash: '#/' }
  const swaps = []
  const pending = []
  const routeSwaps = latch ? latch.createRouteSwapLatch({ now: () => clock.value }) : inertLatch()
  const document = {
    /* The browser's order: the swap waits for a frame. A new transition skips
       the running one, whose swap is nevertheless still called. */
    startViewTransition(callback) {
      let settle
      const updateCallbackDone = new Promise((resolve, reject) => { settle = { resolve, reject } })
      pending.push(() => {
        try { callback(); settle.resolve() } catch (error) { settle.reject(error) }
      })
      const done = Promise.resolve()
      return { ready: done, finished: done, updateCallbackDone }
    },
  }
  const bindings = {
    location, document, swaps, routeSwaps,
    historyEntries: { isUndoEcho: () => false, refuse() {}, settle() {} },
    parse: () => location.hash,
    resolve: hash => hash.startsWith('#/computers/')
      ? { name: 'computers', comp: hash.slice('#/computers/'.length) }
      : { name: 'home' },
    checkoutSurfaceSettled: () => true,
    syncFirstRunChrome() {},
    shouldOpenSetup: () => false,
    SETUP_RESOLUTION: {},
    takeViewMorph: () => null,
    performance: { now: () => clock.value },
    pageCanAnimate: () => true,
    supportsViewTransition: true,
    motionReduced: () => false,
  }
  // eslint-disable-next-line no-new-func -- the production render() out of a file node cannot import.
  const router = new Function(...Object.keys(bindings), `
    let current = { route: { name: 'home' }, view: {}, hash: '#/' }
    function swapView(route, morph, zoom, snapshotted) {
      swaps.push(route)
      current = { route, view: { mount: swaps.length }, hash: location.hash }
    }
    ${renderSource()}
    return { render, get current() { return current } }
  `)(...Object.values(bindings))
  return {
    location, swaps, router,
    frame: async () => {
      for (const run of pending.splice(0)) run()
      for (let i = 0; i < 4; i += 1) await Promise.resolve()
    },
  }
}

test('a render of the page a swap is already bringing in does not mount that page twice', async () => {
  const f = routerFixture()
  f.location.hash = '#/computers/this-computer'
  f.router.render()          // the hashchange drainTreeNodeCommands caused
  f.router.render()          // its 120 ms re-drain, before the browser's next frame
  await f.frame()
  assert.deepEqual(f.swaps.map(route => route.name), ['computers'],
    'Computers must mount once; a second mount retires the copy that took the agent\'s request')
  assert.equal(f.router.current.view.mount, 1)
})

test('once that swap has run, a later render of the same page rebuilds it as before', async () => {
  const f = routerFixture()
  f.location.hash = '#/computers/this-computer'
  f.router.render()
  await f.frame()
  f.router.render()          // e.g. a real data-source change on the mounted page
  await f.frame()
  assert.equal(f.swaps.length, 2)
})

test('a render of a different address while a swap is pending is not held back', async () => {
  const f = routerFixture()
  f.location.hash = '#/computers/this-computer'
  f.router.render()
  f.location.hash = '#/'
  f.router.render()
  await f.frame()
  assert.deepEqual(f.swaps.map(route => route.name), ['computers', 'home'])
  assert.equal(f.router.current.route.name, 'home')
})

test('a swap that never comes stops holding renders back after its bound', async () => {
  assert.ok(latch, 'src/route-swap-latch.js must exist')
  const clock = { value: 1_000 }
  const f = routerFixture({ clock })
  f.location.hash = '#/computers/this-computer'
  f.router.render()
  clock.value += latch.ROUTE_SWAP_TRUST_MS
  f.router.render()
  await f.frame()
  assert.equal(f.swaps.length, 2, 'past the bound, render() behaves exactly as it did before the latch')
})

test('the latch clears only the swap it was given, and only covers its own address', () => {
  assert.ok(latch, 'src/route-swap-latch.js must exist')
  const clock = { value: 0 }
  const swaps = latch.createRouteSwapLatch({ now: () => clock.value })
  const first = swaps.begin('#/computers/a')
  assert.equal(swaps.covers('#/computers/a'), true)
  assert.equal(swaps.covers('#/computers/b'), false)
  const second = swaps.begin('#/computers/b')
  swaps.end(first)
  assert.equal(swaps.covers('#/computers/b'), true, 'an older swap landing must not clear a newer one')
  swaps.end(second)
  assert.equal(swaps.covers('#/computers/b'), false)
})
