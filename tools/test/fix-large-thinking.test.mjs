// Fix (C) originally separated the working note from the conversation.
// Compact previews now follow the latest public response (an earlier commit): internal
// reasoning remains transcript activity and must not replace or accompany that
// response on any compact card. Keep the real Large/Medium/Mini renderer probe
// and the supplied reasoning control while checking this current contract.
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
const data = fs.mkdtempSync(testScratchRoot('fix-largecard-'))
const env = sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(path.join(data, 'environment'))))
for (const key of Object.keys(env)) if (/^NODE_OPTIONS$/i.test(key)) delete env[key]
const esbuild = require('esbuild')
let observed
try {
  await esbuild.build({ entryPoints: [path.join(root, 'tools/test/helpers/fix-largecard-renderer.mjs')], bundle: true,
    format: 'iife', outfile: path.join(data, 'fixture.js'), loader: { '.woff2': 'dataurl' }, logLevel: 'silent' })
  fs.writeFileSync(path.join(data, 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; font-src data:; img-src data:"><title>Fix large cards</title><link rel="stylesheet" href="./fixture.css"><body><script src="./fixture.js"></script></body>\n')
  const execution = await promisify(execFile)(require('electron'), [path.join(root, 'tools/test/helpers/fix-largecard-electron.cjs'), data], {
    cwd: root, env, windowsHide: true, timeout: 90000, maxBuffer: 1024 * 1024,
  })
  fs.writeFileSync(path.join(data, 'execution.json'), JSON.stringify(execution, null, 2) + '\n')
  observed = JSON.parse(fs.readFileSync(path.join(data, 'observations.json'), 'utf8'))
} finally {
  esbuild.stop()
  console.log('Fix large-card evidence: ' + data.replaceAll('\\', '/'))
}

const at = size => { const s = observed.sizes[size]; assert.ok(s, `missing size ${size}`); return s }
// fixture-1 is the only agent the feed gives a thinking note to.
const thinker = size => { const c = at(size).cards.find(card => card.id === 'fixture-1'); assert.ok(c, `${size}: no thinking card`); return c }
const quiet = size => { const c = at(size).cards.find(card => card.id === 'fixture-0'); assert.ok(c, `${size}: no quiet card`); return c }

test('the harness stayed hidden, sandboxed and offline', () => {
  assert.equal(observed.failure, undefined, JSON.stringify(observed.failure))
  assert.deepEqual(observed.pageErrors, [])
  assert.deepEqual(observed.deniedRequests, [])
  assert.equal(observed.visible, false)
  assert.equal(observed.destroyed, true)
  assert.deepEqual(Object.keys(observed.sizes), ['large', 'medium', 'mini'])
  for (const size of ['large', 'medium', 'mini']) assert.equal(at(size).actualSize, size)
})

test('a Large box keeps supplied internal reasoning out of its public preview', () => {
  const card = thinker('large')
  assert.ok(at('large').expectedThinking.length > 0, 'the fixture must supply an actual working note')
  assert.equal(card.thinkingVisible, false, 'internal reasoning must not be visible at Large: ' + JSON.stringify(card))
  assert.equal(card.captionText, '', 'a hidden working note must not leave a caption: ' + JSON.stringify(card))
  assert.equal(card.thinkingText, '', 'the compact preview must not retain reasoning text: ' + JSON.stringify(card))
  assert.equal(card.thinkingTextAnywhere, false,
    'the supplied working note must not appear anywhere in the card: ' + JSON.stringify(card))
})

test('a Large box keeps its latest public conversation line when reasoning is supplied', () => {
  const card = thinker('large')
  assert.equal(card.conversationVisible, true, 'the conversation line must still be shown: ' + JSON.stringify(card))
  assert.equal(card.conversationLine, at('large').expectedChat,
    'the conversation line must be the conversation, not the working note: ' + JSON.stringify(card))
})

test('a Large box with no working note shows the conversation and no empty caption', () => {
  const card = quiet('large')
  assert.equal(card.conversationLine, at('large').expectedChat, JSON.stringify(card))
  assert.equal(card.thinkingVisible, false, 'no note, no thinking row: ' + JSON.stringify(card))
  assert.equal(card.captionText, '', 'an empty caption is worse than none: ' + JSON.stringify(card))
})

test('Medium and Mini are unchanged: the conversation line, and no thinking row', () => {
  for (const size of ['medium', 'mini']) {
    for (const card of [thinker(size), quiet(size)]) {
      assert.equal(card.conversationLine, at(size).expectedChat,
        `${size}: the conversation line is the conversation: ` + JSON.stringify(card))
      assert.equal(card.thinkingVisible, false, `${size}: no thinking row at this size: ` + JSON.stringify(card))
      assert.equal(card.thinkingTextAnywhere, false,
        `${size}: the working note must not appear anywhere in the card: ` + JSON.stringify(card))
    }
  }
})
