/* THE THIRD REASON A SCREEN IS ON THE EXAMPLE.
 *
 * For most of this product's life there were two: you turned the example on, or
 * you have no ToolsEnabled. The web journey added a third that looks exactly
 * like the second and needs opposite words -- a person who HAS the application,
 * HAS a computer connected, and whose machine went quiet for a minute.
 *
 * Measured on the live site on 2026-08-22: /account/ said the computer
 * "answered just now, so it is awake and ready", and /app/ told the same person
 * to install ToolsEnabled on their computer. Nothing was broken except the
 * sentence, and nothing on the page could have told them so.
 *
 * These tests hold the channel that fixed it: the bridge publishes a finished
 * sentence, the app prefers it, and a missing one is not an error. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const { hostFallbackSentence } = await import(
  new URL('../../src/data-source.js', import.meta.url).href
)

/* Restored after every case: these tests install a fake window, and a leaked
   one would change the answer of any later suite that asks about the host. */
function withWindow(value, body) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window')
  const previous = globalThis.window
  globalThis.window = value
  try { return body() } finally {
    if (had) globalThis.window = previous
    else delete globalThis.window
  }
}

test('a published sentence is handed to the app verbatim', () => {
  const sentence = 'Your computer did not answer just now, so this is the example fleet rather than your own.'
  withWindow({ mcHostFallback: { code: 'WEB_CLIENT_HANDSHAKE_TIMEOUT', sentence } }, () => {
    assert.equal(hostFallbackSentence(), sentence)
  })
})

test('no window at all is not an error', () => {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window')
  const previous = globalThis.window
  if (had) delete globalThis.window
  try { assert.equal(hostFallbackSentence(), null) } finally {
    if (had) globalThis.window = previous
  }
})

test('a window that never published one is not an error', () => {
  withWindow({}, () => { assert.equal(hostFallbackSentence(), null) })
})

test('a malformed reason is refused rather than drawn', () => {
  for (const bad of [null, 42, '', { sentence: 7 }, { sentence: '' }]) {
    withWindow({ mcHostFallback: bad }, () => {
      assert.equal(hostFallbackSentence(), null, `expected null for ${JSON.stringify(bad)}`)
    })
  }
})

test('a reason long enough to reshape the page is refused', () => {
  withWindow({ mcHostFallback: { sentence: 'x'.repeat(401) } }, () => {
    assert.equal(hostFallbackSentence(), null)
  })
  withWindow({ mcHostFallback: { sentence: 'x'.repeat(400) } }, () => {
    assert.equal(hostFallbackSentence().length, 400)
  })
})

test('a getter that throws is survived', () => {
  const hostile = {}
  Object.defineProperty(hostile, 'mcHostFallback', {
    get() { throw new Error('hostile host') },
  })
  withWindow(hostile, () => { assert.equal(hostFallbackSentence(), null) })
})

/* THE SENTENCE THAT WAS WRONG MUST STAY REACHABLE ONLY AS A FALLBACK. A future
   edit that drops the hostFallbackSentence() call would restore the measured
   defect exactly, and every test above would still pass, because they test the
   channel and not the surface that reads it. */
test('the computers view prefers the bridge reason over the install sentence', async () => {
  const source = await readFile(path.join(ROOT, 'src', 'views', 'computers.js'), 'utf8')
  const start = source.indexOf('const exampleExitSentence')
  assert.ok(start > 0, 'exampleExitSentence should still exist')
  const body = source.slice(start, start + 900)
  assert.ok(
    body.includes('hostFallbackSentence()'),
    'the no-host branch must ask the bridge for its reason before falling back to "Install ToolsEnabled"',
  )
  const asks = body.indexOf('hostFallbackSentence()')
  const installs = body.indexOf('Install ToolsEnabled on your computer')
  assert.ok(asks < installs, 'the bridge reason must win when there is one')
})

/* THE CHANNEL IS NOT THE FIX. The first version of this shipped with the
   sentence reaching `window` perfectly and the screen never changing, because
   the page had been drawn half a minute before the answer arrived. These hold
   the half that repaints it. */
test('the view listens for the host fallback event', async () => {
  const source = await readFile(path.join(ROOT, 'src', 'views', 'computers.js'), 'utf8')
  assert.ok(
    source.includes('HOST_FALLBACK_EVENT'),
    'the computers view must listen for the host fallback announcement, or the reason arrives after the paint and is never drawn',
  )
  assert.ok(
    /addEventListener\(HOST_FALLBACK_EVENT/.test(source),
    'the event must actually be subscribed to, not merely imported',
  )
  assert.ok(
    /removeEventListener\(HOST_FALLBACK_EVENT/.test(source),
    'the subscription must be torn down with the view',
  )
})

test('the host fallback event is not the data-source event', async () => {
  const { HOST_FALLBACK_EVENT, DATA_SOURCE_EVENT } = await import(
    new URL('../../src/data-source.js', import.meta.url).href
  )
  /* Reusing DATA_SOURCE_EVENT makes every open view re-resolve; the verdict is
     still 'mock', the re-resolve starts another handshake, and its failure
     announces again -- once every thirty seconds, forever. */
  assert.notEqual(HOST_FALLBACK_EVENT, DATA_SOURCE_EVENT)
  assert.equal(typeof HOST_FALLBACK_EVENT, 'string')
  assert.ok(HOST_FALLBACK_EVENT.length > 0)
})
