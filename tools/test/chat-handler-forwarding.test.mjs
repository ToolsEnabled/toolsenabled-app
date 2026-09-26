/* A WRAPPER THAT REBUILDS THE HANDLERS OBJECT SILENTLY DROPS WHAT IT DOES NOT
 * KNOW ABOUT.
 *
 * The rail chat in views/computers.js wraps a caller's `onSend` for one reason:
 * a reply on the rail goes into the rail's own stream rather than straight into
 * the log. It did that by constructing a fresh `{ reply, fail }` object, which
 * was harmless right up until the composer began handing `attachments` through
 * that same argument. Then a file a person picked on the rail reached the
 * wrapper and stopped there -- and the fallback that used to catch it, a Set the
 * view filled at pick time, had been removed in the same change as redundant.
 * The customer sees a chip, presses Send, and nothing rides.
 *
 * It is invisible from either side: components.js sends attachments correctly,
 * computers.js reads them correctly, and the wrapper between them is the only
 * place the value is lost. So this asserts the wrapper's contract directly --
 * everything the composer hands it arrives, and the one key it exists to
 * replace is replaced.
 *
 * THE BAD VALUE: a wrapper built as `{ reply, fail }`. Restore that shape and
 * the first assertion fails with attachments undefined.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../../src/views/computers.js', import.meta.url), 'utf8')

/* The wrapper, taken from the shipped source rather than described from
   memory: the assertion is about what this file actually does. */
const WRAPPER = /onSend: \(text, handlers\) => config\.onSend\(text, \{([\s\S]{0,900}?)\n\s*\}\),/

test('the rail chat wrapper forwards every handler it was given', () => {
  const found = source.match(WRAPPER)
  assert.ok(found, 'the rail chat onSend wrapper was not found, so this test read nothing and proved nothing')
  const body = found[1]

  assert.match(body, /\.\.\.handlers/,
    'the wrapper rebuilds the handlers object instead of spreading it, so anything the composer adds -- attachments today -- is dropped between the composer and the send')

  /* And it still does the job it exists for, or the spread has quietly turned
     the wrapper into a pass-through and the rail stream never gets the reply. */
  assert.match(body, /reply:/, 'the wrapper no longer overrides reply, which is the only reason it exists')

  const spreadAt = body.indexOf('...handlers')
  const replyAt = body.indexOf('reply:')
  assert.ok(spreadAt < replyAt,
    'the spread comes after the reply override, so the caller\'s reply wins and the rail stream is bypassed')
})

test('the send path reads attachments from the handler argument, not from a view-held cache', () => {
  /* The other half of the same contract. If treeCardSend went back to reading
     only its own Set, forwarding would be pointless and this file would pass
     while the feature stayed broken. */
  const send = source.match(/function treeCardSend\(node, text, \{([^}]*)\}\)/)
  assert.ok(send, 'treeCardSend no longer destructures its handlers, so the contract this asserts has moved')
  assert.match(send[1], /attachments/,
    'treeCardSend does not accept attachments, so a forwarded value would have nowhere to land')
})
