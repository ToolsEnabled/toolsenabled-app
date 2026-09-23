/* THE DOOR TO THE COMPARE WINDOW, AND THE REASON IT IS SOMETIMES SHUT.
 *
 * The window itself is driven in tools/test/diff-editor.test.mjs. This file is
 * about the one thing that suite cannot see: whether a person can get to it,
 * and what the page says on a copy where it cannot work.
 *
 * THE ROW CARRIES ITS OWN BLOCKED REASON AS A FUNCTION, so this suite calls it
 * rather than reading the page's source and hoping. The two places that
 * function is consulted -- the button's disabled state and the sentence beside
 * it -- are now DRAWN and read back out, because rowMarkup() and rowMessage()
 * are string functions and need no document at all. The earlier version of this
 * file counted occurrences of a literal expression instead, and that count was
 * still right with the behaviour removed.
 *
 * WHAT IS STILL READ FROM THE SOURCE, and the whole of it: that the page opens
 * the window through its door and takes it down in destroy(). settingsView()
 * does need a live document. Everything the door itself does -- one window and
 * not two, the bridge that reaches the main process, the host node coming off
 * the body -- is driven in tools/test/diff-editor.test.mjs.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { register } from 'node:module'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/* The view imports its stylesheets and node cannot load one. Same hook, same
   reason, as tools/test/cloud-mirror-setup.test.mjs. */
register('./helpers/css-stub-loader.mjs', import.meta.url)
const { SETTINGS, rowMarkup, rowMessage } = await import('../../src/views/settings.js')

const row = SETTINGS.find(setting => setting.id === 'compare_files')

test('the compare window has exactly one door, and it is a row a person can press', () => {
  assert.ok(row, 'nothing on the settings page opens the compare window')
  assert.equal(row.type, 'action')
  assert.equal(row.action, 'compare-files')
  assert.equal(row.actionLabel, 'Compare two files')
  assert.equal(row.section, 'App permissions')

  const source = readFileSync(path.join(REPO, 'src', 'views', 'settings.js'), 'utf8')
  const handlers = [...source.matchAll(/data-setting-action="compare-files"/g)]
  assert.equal(handlers.length, 1,
    'the compare window is reached from more than one place; one path per thing')
  assert.match(source, /compareFiles\.open\(\)/, 'the row is declared and nothing opens the window')
  /* WHAT THE HOST NODE DOES ON OPEN AND ON CLOSE IS NO LONGER ASSERTED HERE.
     It used to be pinned as a line of source, which reads as lifecycle
     coverage and is not: the same pin passed while leaving Settings left the
     window mounted over the next page. The mounting moved into
     createCompareFilesDoor() in src/diff-editor.js and is driven in
     tools/test/diff-editor.test.mjs -- one window not two, the host node off
     the body on close, and the page's own destroy() calling it. */
})

test('the row is disabled with its reason where the window cannot work, and live where it can', () => {
  assert.equal(typeof row.blockedReason, 'function', 'the row carries no reason for being unavailable')
  const before = globalThis.mcDiff
  try {
    delete globalThis.mcDiff
    const reason = row.blockedReason()
    assert.ok(reason, 'a browser with no installed program still offers a window that cannot open a file')
    assert.match(reason, /installed program/i)
    assert.match(reason, /Install ToolsEnabled/i, 'the reason does not say what to do about it')
    assert.equal(/[A-Z]{2,}_[A-Z]/.test(reason), false, 'the reason prints a machine code')

    globalThis.mcDiff = { pick: () => {}, stamp: () => {}, save: () => {} }
    assert.equal(row.blockedReason(), null, 'the row stays blocked on a copy that can open files')
  } finally {
    if (before === undefined) delete globalThis.mcDiff
    else globalThis.mcDiff = before
  }
})

test('both halves of the disabled-with-its-reason rule are drawn, not merely spelled', () => {
  /* WHAT THIS TEST USED TO DO AND WHY IT WAS NOT ENOUGH. It counted two
     occurrences of a literal expression and grepped for `disabled title=`. That
     passed with the behaviour removed: dropping `blocked ||` from the row's
     sentence left the disabled button sitting beside a description of a thing
     the person cannot do, and the count was still two. The row is DRAWN here
     instead, in both states, and read back out of the markup. */
  const withoutHost = () => {
    const before = globalThis.mcDiff
    delete globalThis.mcDiff
    try { return { reason: row.blockedReason(), message: rowMessage(row), markup: rowMarkup(row) } } finally {
      if (before !== undefined) globalThis.mcDiff = before
    }
  }
  const withHost = () => {
    const before = globalThis.mcDiff
    globalThis.mcDiff = { pick: () => {}, stamp: () => {}, save: () => {} }
    try { return { message: rowMessage(row), markup: rowMarkup(row) } } finally {
      if (before === undefined) delete globalThis.mcDiff
      else globalThis.mcDiff = before
    }
  }

  const shut = withoutHost()
  assert.equal(shut.message, shut.reason,
    'the row draws its description where a person needs the reason the control is dead')
  assert.match(shut.message, /installed program/i)
  assert.equal(shut.message.includes(row.desc.slice(0, 40)), false,
    'the disabled row still shows its description, so the reason is nowhere on the row')
  assert.match(shut.markup, /data-setting-message>[^<]*installed program/i,
    'the reason is not drawn in the row')
  assert.match(shut.markup, /data-setting-action="compare-files"[^>]*disabled/,
    'the action button does not disable itself when its row reports a reason')
  assert.match(shut.markup, /disabled title="[^"]*installed program/i,
    'the disabled button carries no reason of its own')

  const live = withHost()
  assert.match(live.message, /Open two files side by side/,
    'a row that can be used no longer shows what it does')
  assert.equal(/data-setting-action="compare-files"[^>]*disabled/.test(live.markup), false,
    'the row stays disabled on a copy that can open files')
  assert.equal(live.markup.includes('installed program'), false)
})

test('the compare row is declared beside the one it was built like, and states its own risk', async () => {
  const { describeSubject } = await import('../../src/permission-guidance.js')
  const guidance = describeSubject('compare_files', { section: row.section })
  assert.equal(guidance.declared, true, 'the row grants a person a file write and says nothing about it')
  assert.ok(guidance.capabilities.length > 0)
  assert.ok(guidance.risks.length > 0)
  assert.match(guidance.risks.join(' '), /nothing here undoes it/i,
    'the statement no longer says that a save cannot be taken back, which is the fact about this row')
  assert.match(guidance.risks.join(' '), /may have moved since an agent produced/i,
    'the statement no longer carries the staleness point the owner asked to be said out loud')
})
