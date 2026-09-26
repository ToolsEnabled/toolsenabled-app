// Release rendering retains no diagnostic samples, stronger than a bounded tail.
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderChatMarkdown } from '../../src/chat-markdown.js'

test('repeated markdown rendering retains no diagnostic globals or samples', () => {
  const previous = globalThis.window
  globalThis.window = {}
  try {
    for (let i = 0; i < 500; i++) {
      const result = renderChatMarkdown('reply ' + i + ' with **bold** and a [link](https://example.com)')
      assert.match(result, /<strong/)
      assert.match(result, /<a /)
    }
    assert.deepEqual(Reflect.ownKeys(globalThis.window), [])
  } finally {
    if (previous === undefined) delete globalThis.window
    else globalThis.window = previous
  }
})
