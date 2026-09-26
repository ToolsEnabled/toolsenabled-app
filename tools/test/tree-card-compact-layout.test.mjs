import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { testScratchRoot } from '../lib/test-scratch-root.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(import.meta.url)
const { prepareSterileProfile, sterileProfileDirectories, sterileLaunchEnvironment } = require('../lib/sterile-launch.cjs')
const data = fs.mkdtempSync(testScratchRoot('tree-card-compact-'))
const env = sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(path.join(data, 'environment'))))
for (const key of Object.keys(env)) if (/^NODE_OPTIONS$/i.test(key)) delete env[key]
const esbuild = require('esbuild')
let observed
try {
  await esbuild.build({
    entryPoints: [path.join(root, 'tools/test/helpers/tree-card-compact-renderer.mjs')],
    bundle: true, format: 'iife', outfile: path.join(data, 'fixture.js'),
    loader: { '.woff2': 'dataurl' }, logLevel: 'silent',
    /* See the same line in topbar-pixel-snap: esbuild does not read
       NODE_PATH, so without this the suite cannot BUILD in a worktree that
       borrows the shared dependency store instead of junctioning to it.
       Assertion-neutral and inert when the tree has its own dependencies. */
    nodePaths: process.env.NODE_PATH ? process.env.NODE_PATH.split(path.delimiter).filter(Boolean) : [],
  })
  fs.writeFileSync(path.join(data, 'index.html'), `<!doctype html>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src data:; img-src data:">
    <link rel="stylesheet" href="./fixture.css">
    <body><script src="./fixture.js"></script></body>`)
  const result = await promisify(execFile)(require('electron'), [
    path.join(root, 'tools/test/helpers/tree-card-compact-electron.cjs'), data,
  ], { cwd: root, env, windowsHide: true, timeout: 45000, maxBuffer: 1048576 })
  fs.writeFileSync(path.join(data, 'execution.json'), JSON.stringify(result, null, 2) + '\n')
  observed = JSON.parse(fs.readFileSync(path.join(data, 'observations.json'), 'utf8'))
} finally {
  esbuild.stop()
  console.log('Card layout evidence: ' + data.replaceAll('\\', '/'))
}

for (const style of ['boxes', 'circles']) {
  test(`${style}: Mini through Large preserve readable content and compact headers`, () => {
    const rows = observed.rows.filter(row => row.style === style)
    assert.deepEqual(rows.map(row => row.size), ['mini', 'small', 'medium', 'large'])
    for (const row of rows) {
      assert.equal(row.actualSize, row.size)
      assert.equal(row.savedUnchanged, true)
      assert.equal(row.keyboardOpened, true, JSON.stringify(row))
      assert.ok(row.cards.length)
      if (style === 'boxes') {
        assert.equal(row.equalTransitions.length, row.cards.length)
        for (const transition of row.equalTransitions) {
          const { before, publicResponse, unchanged } = transition
          assert.equal(before.tail.endVisible, false, 'the long fallback initially shows its beginning')
          assert.equal(publicResponse.text, before.text, 'this transition changes response mode without changing its parsed tail')
          assert.ok(publicResponse.tail.endVisible, JSON.stringify({ size: row.size, transition }))
          assert.ok(publicResponse.tail.scrollBottomGap <= 1)
          assert.deepEqual(unchanged, publicResponse, 'an identical refresh keeps the public tail visible')
        }
      }
      for (const update of row.streamed) {
        assert.ok(update.text.endsWith(update.ending))
        assert.ok(update.tail.endVisible, JSON.stringify({ size: row.size, update }))
        assert.ok(update.tail.scrollBottomGap <= 1, JSON.stringify({ size: row.size, update }))
      }
      for (const card of row.cards) {
        assert.ok(card.accessible)
        assert.ok(card.headerAction, JSON.stringify({ size: row.size, card }))
        assert.deepEqual(card.labels, [])
        assert.equal(card.thinking, null, 'compact cards must not expose internal reasoning')
        assert.equal(card.internalReasoningVisible, false)
        assert.ok(card.text.endsWith('Newest result.'))
        assert.ok(card.tail.endVisible, JSON.stringify({ size: row.size, card }))
        assert.ok(card.tail.scrollBottomGap <= 1, JSON.stringify({ size: row.size, card }))
        assert.equal(card.containsOriginalTask, false)
        assert.equal(card.contentOnlyOnce, true)
        assert.ok(card.content.height > 0)
        assert.ok(card.content.bottom <= card.body.bottom + 1, JSON.stringify({ size: row.size, card }))
        assert.ok(card.actionText.startsWith('Read the shared'))
        assert.ok(card.content.width <= card.body.width + 1)
        if (card.thinking) assert.ok(card.thinking.bottom <= card.content.y + 1, 'thinking and context have separate space')
      }
    }
  })
}

test('the actual workspace toolbar selects Mini and retains its latest action and conversation', () => {
  assert.deepEqual(observed.toolbarMini.options, ['mini', 'small', 'medium', 'large'])
  assert.equal(observed.toolbarMini.selected.value, 'mini')
  assert.equal(observed.toolbarMini.selected.actualSize, 'mini')
  assert.equal(observed.toolbarMini.selected.policy.defaultSize, 'mini')
  assert.ok(Object.values(observed.toolbarMini.selected.policy.trees).every(value => value === 'mini'))
  assert.match(observed.toolbarMini.latestAction, /Read the shared account/)
  assert.match(observed.toolbarMini.context, /latest verification/)
})

test('offscreen browser proof leaves no owner window or external request', () => {
  assert.equal(observed.visible, false)
  assert.equal(observed.destroyed, true)
  assert.deepEqual(observed.pageErrors, [])
  assert.deepEqual(observed.deniedRequests, [])
})
