/* The browser-facing Codex Cloud module cannot be imported by plain Node: its
 * stylesheet import is intentionally handled by Vite.  These tests therefore
 * exercise the controller API that cloud-tasks.js re-exports and make the
 * smallest possible source checks that prove the browser module keeps its
 * user-facing fences and wiring.  No loader is installed here: a test-only CSS
 * loader would make this a test of a different module-loading environment.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  createCloudTaskController,
  diffRefusalMessage,
} from '../../src/cloud-tasks-controller.js'

const source = readFileSync(
  fileURLToPath(new URL('../../src/cloud-tasks.js', import.meta.url)),
  'utf8',
)

const READY = Object.freeze({ ok: true, code: null, note: 'Codex Cloud ready.' })

test('the browser module keeps demonstration pages from launching billable work', () => {
  assert.match(
    source,
    /export function mountCloudTaskSurface\(root,\s*\{\s*live\s*=\s*false[^)]*\}[^{]*\)\s*\{[\s\S]*?if\s*\(live\s*!==\s*true\)\s*return\s*\(\)\s*=>\s*\{\}/,
    'mountCloudTaskSurface must default to inert and return before cloud availability or controller setup',
  )
})

test('a failed task read remains unknown rather than becoming a definite empty list', async () => {
  const controller = createCloudTaskController({
    availability: READY,
    postAction: async action => {
      if (action === 'cloud-accounts') {
        return { ok: true, receipt: { accounts: [], environments: [], tasks: [] } }
      }
      return { ok: false, code: 'CLOUD_TASKS_UNREADABLE', reason: 'The task list could not be read.' }
    },
  })

  await controller.loadTasks()
  const state = controller.getState()
  assert.equal(state.listTone, 'refused', 'a could-not-read reply must remain a refusal, not an empty-list answer')
  assert.equal(state.listCode, 'CLOUD_TASKS_UNREADABLE', 'the read refusal code must remain available to support')
  assert.match(state.listMessage, /could not be read/i, 'the list answer must say the read failed')

  assert.match(
    source,
    /stateNode\(listOutput,\s*next\.listTone,\s*readerSentence\(next\.listMessage\),\s*next\.listCode\)/,
    'the agent surface must render the controller refusal, relay-aware, with its refusal code',
  )
  assert.match(
    source,
    /stateNode\(listOut,\s*next\.listTone,\s*readerSentence\(next\.listMessage\),\s*next\.listCode\)/,
    'the fleet surface must render the controller refusal, relay-aware, with its refusal code',
  )
})

test('diff refusal copy promises neither missing work nor an applied change', () => {
  const message = diffRefusalMessage({
    code: 'CLOUD_DIFF_UNREADABLE',
    reason: 'The diff could not be read.',
  })

  assert.match(message, /could not be read/i, 'a diff read failure must describe uncertainty, not claim there was no work')
  assert.match(message, /nothing was changed/i, 'a diff refusal must say that the local tree was not changed')
  assert.doesNotMatch(message, /changed nothing|no changes/i, 'a diff read failure must not collapse into a definite no-change answer')
  assert.match(
    source,
    /diffRefusalMessage[\s\S]*?from\s+'\.\/cloud-tasks-controller\.js'/,
    'cloud-tasks.js must publicly expose the tested diff-refusal composition',
  )
})
