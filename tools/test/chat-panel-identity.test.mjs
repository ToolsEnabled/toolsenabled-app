/* THE PANEL HAD NO IDENTITY MARKER. Three surfaces mount buildChat's root (the
 * rail's Chat tab, the compact card on the fleet-tree canvas, the full-page
 * chat) and nothing in the DOM said "this element IS the chat panel" beyond
 * the bare `.chat` class -- indistinguishable from any other element someone
 * later decides to name `.chat` for an unrelated reason. data-chat-panel is a
 * deliberate, single-purpose hook: a caller or a test can find "the chat
 * panel, wherever it is mounted" without depending on `.chat`'s styling class
 * staying exclusive to this component forever.
 *
 * Source pins, deliberately: buildChat needs a DOM to run, and the harness
 * here has none (see tools/test/chat-composer.test.mjs's header for the same
 * note). */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')
const components = readFileSync(join(SRC, 'components.js'), 'utf8')
const chat = components.slice(components.indexOf('export function buildChat'))

test('the chat panel root carries a data-chat-panel marker', () => {
  const root = chat.slice(chat.indexOf('const root = el(`'), chat.indexOf('const root = el(`') + 400)
  assert.match(root, /class="chat\$\{cannotSend[^}]*\}"\s+data-chat-panel/,
    'data-chat-panel is missing (or no longer sits) on the buildChat root element')
})
