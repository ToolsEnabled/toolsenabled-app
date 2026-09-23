// THE ONE RULE THE ROUTER AND EVERY VIEW SHARE: what "after the next frame"
// means on a page that will never have one.
//
// WHY THIS TEST EXISTS AS A UNIT TEST AT ALL. The defect it guards is only
// visible on a real covered window (a packaged build, a heap snapshot, a
// pending-frame census), and that measurement cannot run here. What CAN be
// pinned here is the contract the measurement led to -- because the risk of
// the fix is not the frameless path, which is measured, but the VISIBLE one:
// a page that can draw must behave exactly as it did before, and "exactly as
// before" is a statement about delegation and timing that a test can hold.
//
// The window is a stub rather than a DOM: this module reads two things
// (document.visibilityState, one layout property) and calls one function.
// Anything heavier would test jsdom.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SOURCE = new URL('../../src/page-frames.js', import.meta.url)

/** Load the module against a stubbed document, since it reads globals at call time. */
async function load({ visibilityState }) {
  const reads = { layout: 0 }
  const frames = []
  globalThis.document = {
    get visibilityState() { return visibilityState.value },
    documentElement: { get offsetHeight() { reads.layout += 1; return 1000 } },
  }
  globalThis.requestAnimationFrame = (callback) => { frames.push(callback); return 100 + frames.length }
  /* A fresh module instance per case, so no state can leak between them. */
  const module = await import(`${SOURCE.href}?case=${Math.random()}`)
  return { module, reads, frames }
}

test('a page that can draw goes through requestAnimationFrame, unchanged', async () => {
  const visibilityState = { value: 'visible' }
  const { module, reads, frames } = await load({ visibilityState })
  let ran = 0
  const handle = module.onNextFrame(() => { ran += 1 })

  assert.equal(ran, 0, 'the work must NOT run synchronously on a page that can draw')
  assert.equal(frames.length, 1, 'exactly one frame is requested')
  assert.equal(handle, 101, 'the frame handle is returned, so callers can still cancel it')
  assert.equal(reads.layout, 0, 'no layout is forced on the path that was already correct')

  frames[0]()
  assert.equal(ran, 1, 'the work runs when the frame arrives, exactly once')
})

test('a page that cannot draw does the work now, after a layout flush', async () => {
  const visibilityState = { value: 'hidden' }
  const { module, reads, frames } = await load({ visibilityState })
  const order = []
  globalThis.document.documentElement = { get offsetHeight() { order.push('layout'); return 1000 } }
  const handle = module.onNextFrame(() => order.push('work'))

  assert.deepEqual(order, ['layout', 'work'], 'the layout is flushed BEFORE the work reads geometry')
  assert.equal(frames.length, 0, 'nothing is queued on a page that will never service the queue')
  assert.equal(handle, 0, 'a handle of 0 says there is nothing left to cancel')
})

test('the rule is read per call, not captured once', async () => {
  const visibilityState = { value: 'visible' }
  const { module, frames } = await load({ visibilityState })
  assert.equal(module.pageCanDraw(), true)
  visibilityState.value = 'hidden'
  assert.equal(module.pageCanDraw(), false, 'a window is covered and uncovered all day; each call answers for now')

  let ran = 0
  module.onNextFrame(() => { ran += 1 })
  assert.equal(ran, 1, 'after the page went frameless the very next call takes the immediate path')
  assert.equal(frames.length, 0)
})

test('every scheduling site the measurement named goes through the primitive', () => {
  /* The census named five call sites and a sixth was found the same way after
     the first five were fixed. A file that reverts to a bare
     requestAnimationFrame at one of them would leak again with no test to say
     so, so the import is what is pinned -- deliberately not the count, which
     would fail the next time someone adds a legitimate animation loop. */
  for (const file of ['../../src/components.js', '../../src/views/comms.js', '../../src/views/home.js', '../../src/crescent-mount.js', '../../src/main.js']) {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.match(text, /from '\.\.?\/page-frames\.js'/, `${file} must take the shared page-can-draw rule from one place`)
  }
})
