import assert from 'node:assert/strict'
import test from 'node:test'

import { createTranscriptAppender, DEFAULT_CHUNK_MAX } from '../../src/agent-session-transcript.js'

/* The transcript is the surface that receives one event PER TOKEN from a live
 * agent session, so its append path is the hottest code in the renderer. These
 * tests pin two separate properties, and both matter:
 *
 *   COMPLETENESS -- every character arrives, once, in order. A "fast"
 *   transcript that loses output is a broken product, and making the append
 *   cheap is exactly the change that could lose some.
 *
 *   COST SHAPE -- the work stays linear in the text appended. This is pinned
 *   mechanically, by counting the characters the DOM is asked to copy, rather
 *   than by timing anything. A timing assertion on a shared build machine is a
 *   flake generator; a copy count is deterministic and fails for exactly the
 *   reason we care about.
 */

// ---------- a DOM stub narrow enough to be obviously correct ----------
// It implements only what the appender touches, and it counts every character
// the appender asks the DOM to copy.

class FakeText {
  constructor(data, meter) {
    this.data = data
    this.meter = meter
    meter.copied += data.length
    meter.writes += 1
  }
  get length() { return this.data.length }
  appendData(text) {
    // A real CharacterData.appendData copies the appended text into the node.
    this.meter.copied += text.length
    this.meter.writes += 1
    this.data += text
  }
}

class FakeNode {
  constructor(meter) {
    this.childNodes = []
    this.hidden = true
    this.meter = meter
  }
  appendChild(child) { this.childNodes.push(child); return child }
  get textContent() { return this.childNodes.map(c => c.data).join('') }
  /* Assigning textContent replaces the node's contents, so the browser copies
     the WHOLE assigned string. Metering it here is what lets the cost-shape
     test below tell a linear append apart from the quadratic
     `textContent += delta` this module was written to replace -- and what lets
     that original defect be re-planted verbatim to prove the test fails. */
  set textContent(value) {
    this.meter.copied += value.length
    this.meter.writes += 1
    this.childNodes = value === '' ? [] : [{ data: value, length: value.length }]
  }
}

function harness({ chunkMax = DEFAULT_CHUNK_MAX } = {}) {
  const meter = { copied: 0, writes: 0 }
  const node = new FakeNode(meter)
  const frames = []
  let nextHandle = 1
  const appender = createTranscriptAppender({
    node,
    chunkMax,
    createTextNode: text => new FakeText(text, meter),
    scheduleFrame: (fn) => { const h = nextHandle++; frames.push({ h, fn }); return h },
    cancelFrame: (h) => { const i = frames.findIndex(f => f.h === h); if (i >= 0) frames.splice(i, 1) },
  })
  return {
    appender, node, meter, frames,
    // Run every frame the appender has requested, as a browser eventually would.
    runFrames() {
      while (frames.length) frames.shift().fn()
    },
  }
}

test('every delta reaches the transcript exactly once and in order', () => {
  const { appender, node, runFrames } = harness()
  // Two regimes, because a buffer bug can hide in either one. Interleaved
  // frames keep the pending buffer short (a browser with a visible window);
  // the long unflushed run lets it grow to thousands (a backgrounded window,
  // or a burst faster than the refresh rate). An earlier version of this test
  // only did the first, and a planted "drop every 100th buffered delta"
  // defect slipped past it because the buffer never got long enough to reach
  // the 100th entry.
  const deltas = Array.from({ length: 5000 }, (_, i) => `d${i} `)
  deltas.forEach((d, i) => {
    appender.push(d)
    if (i % 97 === 0) runFrames()
  })
  runFrames()

  const burst = Array.from({ length: 2000 }, (_, i) => `b${i} `)
  for (const d of burst) appender.push(d)   // no frames at all during the burst
  runFrames()

  assert.equal(
    node.textContent,
    deltas.join('') + burst.join(''),
    'the transcript must be the exact concatenation of every delta, in order, in both regimes',
  )
})

test('deltas arriving within one frame produce exactly one DOM write', () => {
  const { appender, meter, runFrames, frames } = harness()
  for (let i = 0; i < 500; i++) appender.push('x')
  assert.equal(meter.writes, 0, 'buffering must touch the DOM zero times')
  assert.equal(frames.length, 1, '500 deltas in one frame must request exactly one frame, not 500')
  runFrames()
  assert.equal(meter.writes, 1, '500 buffered deltas must land in a single DOM write')
})

test('the cost stays LINEAR in the text appended, not quadratic', () => {
  // This is the regression that mattered. The old implementation was
  // `node.textContent += text` per delta, which re-copies the whole transcript
  // every time: for n deltas of length L the DOM copies ~L*n^2/2 characters.
  // Here we assert the DOM is never asked to copy more than a small constant
  // multiple of the text that actually arrived.
  const deltas = 20_000
  const text = ' token'
  const { appender, meter, runFrames } = harness()
  for (let i = 0; i < deltas; i++) {
    appender.push(text)
    if (i % 60 === 59) runFrames()   // a frame roughly every 60 deltas
  }
  runFrames()

  const total = deltas * text.length
  const quadratic = (text.length * deltas * deltas) / 2
  assert.ok(
    meter.copied <= total * 2,
    `expected at most ${total * 2} characters copied for ${total} characters of text, got ${meter.copied}`,
  )
  assert.ok(
    meter.copied < quadratic / 1000,
    `copy count ${meter.copied} is within three orders of magnitude of the quadratic cost ${quadratic}; the batching is not working`,
  )
})

test('no text node grows past the chunk cap, so no single copy is unbounded', () => {
  const chunkMax = 64
  const { appender, node, runFrames } = harness({ chunkMax })
  for (let i = 0; i < 400; i++) { appender.push('abcdefgh'); runFrames() }
  for (const child of node.childNodes) {
    assert.ok(child.length <= chunkMax, `a text node reached ${child.length}, past the ${chunkMax} cap`)
  }
  assert.ok(node.childNodes.length >= Math.floor((400 * 8) / chunkMax), 'text must actually be spread across chunks')
  assert.equal(node.textContent, 'abcdefgh'.repeat(400), 'chunking must not change the text')
})

test('a backgrounded window buffers rather than drops, and flushes on return', () => {
  // requestAnimationFrame does not fire while the window is hidden. Nothing may
  // be lost in the meantime.
  const { appender, node, runFrames } = harness()
  for (let i = 0; i < 1000; i++) appender.push('h')
  assert.equal(node.textContent, '', 'nothing is written while no frame runs')
  assert.equal(appender.pendingCount, 1000, 'every delta is still buffered')
  runFrames()
  assert.equal(node.textContent, 'h'.repeat(1000), 'the whole buffer arrives when frames resume')
})

test('flushNow writes immediately, without waiting for a frame', () => {
  const { appender, node, frames } = harness()
  appender.push('done')
  appender.flushNow()
  assert.equal(node.textContent, 'done')
  assert.equal(frames.length, 0, 'flushNow must cancel the frame it made redundant')
})

test('reset clears the transcript and cancels a pending frame', () => {
  const { appender, node, frames, runFrames } = harness()
  appender.push('old session')
  assert.equal(frames.length, 1)
  appender.reset()
  assert.equal(frames.length, 0, 'a scheduled frame would write the previous session into the new transcript')
  assert.equal(node.hidden, true)
  runFrames()
  assert.equal(node.textContent, '', 'no text from before the reset may appear')
  appender.push('new session')
  runFrames()
  assert.equal(node.textContent, 'new session')
})

test('dispose cancels pending work and writes nothing afterwards', () => {
  const { appender, node, frames, runFrames } = harness()
  appender.push('pending')
  appender.dispose()
  assert.equal(frames.length, 0, 'a frame must not fire against a detached surface')
  appender.push('after dispose')
  runFrames()
  assert.equal(node.textContent, '', 'a disposed appender must never touch the DOM')
})

test('the transcript is revealed once text exists and not before', () => {
  const { appender, node, runFrames } = harness()
  assert.equal(node.hidden, true)
  appender.push('first output')
  assert.equal(node.hidden, true, 'buffering alone must not reveal an empty transcript')
  runFrames()
  assert.equal(node.hidden, false)
})
