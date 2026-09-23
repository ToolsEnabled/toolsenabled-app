// Lane W fix (C): a Large box put the agent's working note WHERE THE
// CONVERSATION LINE GOES, with no caption -- so a large card silently showed
// one thing while labelling it another, and the conversation was gone. Owner's
// words: "cards we are wasting so much space". Large must show a captioned
// Thinking line AND keep the conversation line; Medium and Mini are unchanged.
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
const data = fs.mkdtempSync(testScratchRoot('lanew-fix-largecard-'))
const env = sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(path.join(data, 'environment'))))
for (const key of Object.keys(env)) if (/^NODE_OPTIONS$/i.test(key)) delete env[key]
const esbuild = require('esbuild')
let observed
try {
  await esbuild.build({ entryPoints: [path.join(root, 'tools/test/helpers/lanew-fix-largecard-renderer.mjs')], bundle: true,
    format: 'iife', outfile: path.join(data, 'fixture.js'), loader: { '.woff2': 'dataurl' }, logLevel: 'silent' })
  fs.writeFileSync(path.join(data, 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; font-src data:; img-src data:"><title>Lane W fix large cards</title><link rel="stylesheet" href="./fixture.css"><body><script src="./fixture.js"></script></body>\n')
  const execution = await promisify(execFile)(require('electron'), [path.join(root, 'tools/test/helpers/lanew-fix-largecard-electron.cjs'), data], {
    cwd: root, env, windowsHide: true, timeout: 90000, maxBuffer: 1024 * 1024,
  })
  fs.writeFileSync(path.join(data, 'execution.json'), JSON.stringify(execution, null, 2) + '\n')
  observed = JSON.parse(fs.readFileSync(path.join(data, 'observations.json'), 'utf8'))
} finally {
  esbuild.stop()
  console.log('Lane W fix large-card evidence: ' + data.replaceAll('\\', '/'))
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

test('a Large box shows the working note under its own Thinking caption', () => {
  const card = thinker('large')
  assert.equal(card.thinkingRowPresent, true, 'the Large card must have a thinking row: ' + JSON.stringify(card))
  assert.equal(card.thinkingVisible, true, 'the thinking row must be visible at Large: ' + JSON.stringify(card))
  assert.equal(card.captionText.trim(), 'Thinking',
    'the working note must be captioned, so it is not mistaken for the conversation: ' + JSON.stringify(card))
  assert.equal(card.thinkingText, at('large').expectedThinking,
    'the caption must sit with the actual supplied note: ' + JSON.stringify(card))
})

test('a Large box KEEPS its conversation line beside the thinking', () => {
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
