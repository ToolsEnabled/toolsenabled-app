import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const read = file => readFileSync(new URL('../../' + file, import.meta.url), 'utf8')
const view = read('src/views/comms.js'), css = read('src/comms.css')
test('channels replace the board, while disclosures and message actions remain shared', () => {
  assert.doesNotMatch(view, /watch-pane|wb-box|mode-seg|size-seg|buildChat\(|discord/i)
  assert.match(view, /ownDisclosure\(wrap/)
  assert.match(view, /setChatMessageBody\(/)
  assert.match(view, /addChatMessageCopy\(/)
  assert.equal((view.match(/data-comms-notice="true"/g) || []).length, 1)
  assert.match(view, /hostAbsentMarkup\(/)
  assert.match(view, /commsQuietMarkup\(/)
})
test('live messages come from the runtime journal independently of build-time inventory', () => {
  assert.match(view, /bridge\.localMessages\(options\)/)
  assert.match(view, /createCommsFeed\(/)
  assert.doesNotMatch(view, /fetchOps|ops\.json/)
  assert.match(view, /feed\.destroy\(\)/)
  assert.match(view, /removeEventListener\(DATA_SOURCE_EVENT/)
})
test('the workspace follows shared theme tokens and adapts to the width left by the side panel', () => {
  for (const token of ['--sheet', '--ink', '--line-2', '--font-ui', '--r-md', '--r-lg', '--accent-2', '--focus-ring', '--control-bg']) assert.ok(css.includes(token), token)
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, 'no page-specific hardcoded palette')
  assert.match(css, /container-type: inline-size/)
  assert.match(css, /@container \(max-width: 560px\)/)
  assert.match(css, /prefers-reduced-motion/)
  assert.match(css, /width: calc\(100% - 32px\)/)
})
