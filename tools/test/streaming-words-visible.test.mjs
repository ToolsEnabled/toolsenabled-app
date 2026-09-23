/* THE LIVE REPLY REACHES THE GLASS.
 *
 * MEASURED at app ec82f690, before this change: a reply streamed into a full
 * conversation painted an EMPTY bubble, and the presentation sheet then hid
 * the empty row outright, so a person watching an agent answer saw nothing
 * until the turn completed. src/chat-readable-stream.js withheld any prose
 * that had not yet ended a sentence AND been followed by a space, which for a
 * whole short answer ('The first response.') is the entire live turn.
 *
 * This suite reads the rendered conversation in a real hidden window, because
 * the fact in question is what a person can SEE: chat-presentation.css hides
 * a live row whose body is empty, so "textContent is ''" and "nothing is on
 * the glass" are one event to a reader and two different assertions to a node
 * test. Every claim below comes from checkVisibility() and a painted rect.
 *
 * It also holds the behaviour the fix KEEPS -- an unclosed fence is still
 * withheld -- and records what unholding prose did to the live-thinking
 * choreography, which is a real interaction and not a detail.
 */
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
const data = fs.mkdtempSync(testScratchRoot('streaming-words-visible-'))
const env = sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(path.join(data, 'environment'))))
for (const key of Object.keys(env)) if (/^NODE_OPTIONS$/i.test(key)) delete env[key]
const esbuild = require('esbuild')
let observed
try {
  await esbuild.build({
    entryPoints: [path.join(root, 'tools/test/helpers/streaming-words-visible-renderer.mjs')],
    bundle: true, format: 'iife', outfile: path.join(data, 'fixture.js'),
    loader: { '.woff2': 'dataurl' }, logLevel: 'silent',
  })
  fs.writeFileSync(path.join(data, 'index.html'), `<!doctype html>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src data:; img-src data:">
    <link rel="stylesheet" href="./fixture.css">
    <body><script src="./fixture.js"></script></body>`)
  const result = await promisify(execFile)(require('electron'), [
    path.join(root, 'tools/test/helpers/streaming-words-visible-electron.cjs'), data,
  ], { cwd: root, env, windowsHide: true, timeout: 45000, maxBuffer: 1048576 })
  fs.writeFileSync(path.join(data, 'execution.json'), JSON.stringify(result, null, 2) + '\n')
  observed = JSON.parse(fs.readFileSync(path.join(data, 'observations.json'), 'utf8'))
} finally {
  esbuild.stop()
  console.log('Live reply visibility evidence: ' + data)
}

test('the hidden window ran every scenario with no page error and no outside request', () => {
  assert.equal(observed.failure, undefined, JSON.stringify(observed.failure))
  assert.deepEqual(observed.pageErrors, [])
  assert.deepEqual(observed.deniedRequests, [])
  assert.deepEqual(observed.order, ['liveWords', 'wholeShortAnswer', 'unfinishedFence', 'thinkingBesideSpeech'])
})

test('a reply streamed word by word is on the glass from the first delta', () => {
  const { afterFirstDelta, afterSecondDelta, afterClose } = observed.scenarios.liveWords
  assert.equal(afterFirstDelta.text, 'Streaming', 'the first delta must reach the reader')
  assert.equal(afterFirstDelta.rowVisible, true)
  assert.equal(afterFirstDelta.bodyVisible, true)
  assert.equal(afterFirstDelta.paintedArea, true, 'the row is visible but paints nothing')
  assert.equal(afterFirstDelta.busy, true, 'the turn is still live')
  assert.equal(afterSecondDelta.text, 'Streaming words')
  assert.equal(afterSecondDelta.bodyVisible, true)
  /* The completion still repaints to the computer's saved text, once. */
  assert.equal(afterClose.text, 'Streaming words, saved in full.')
  assert.equal(afterClose.busy, false)
})

test('a whole short answer is readable while it is still live, not only once it settles', () => {
  /* The case the old spacing rule could never release: the only sentence stop
     ends the text, so no following space ever arrives during the turn. */
  const { live, emptyNoteGone, settled } = observed.scenarios.wholeShortAnswer
  assert.equal(live.text, 'The first response.')
  assert.equal(live.bodyVisible, true)
  assert.equal(live.paintedArea, true)
  assert.equal(emptyNoteGone, true, 'the empty-conversation notice outlived the first reply')
  assert.equal(settled.text, 'The first response.')
})

test('an unfinished fence is still withheld, and no backticks reach the reader', () => {
  const { intro, partial, closed } = observed.scenarios.unfinishedFence
  assert.equal(intro.text, 'An introduction')
  assert.equal(partial.text, 'An introduction', 'the partial block was revealed and will change shape')
  assert.equal(partial.literalFence, false, 'fence marks reached the glass as literal text')
  assert.equal(partial.codeBlocks, 0, 'an unclosed fence must not draw a code block yet')
  assert.equal(closed.codeBlocks, 1, 'the closed fence must draw as a bounded element')
  assert.equal(closed.literalFence, false)
})

test('a live answer keeps its thinking reachable, in one group, and never folds a run the reader opened', () => {
  const { whileSpeaking, userOpenedRetained, groups } = observed.scenarios.thinkingBesideSpeech
  assert.equal(whileSpeaking.replyText, 'An unfinished reply', 'speech is withheld again')
  assert.equal(whileSpeaking.replyVisible, true)
  assert.equal(whileSpeaking.thoughtReachable, true, 'the live thought has an unreachable inner window')
  assert.equal(groups, 1, 'the tool calls and the thought split into separate runs')
  assert.equal(userOpenedRetained, true, 'a run the reader opened was folded under them')
})

test('thinking stays open through the thinking phase and folds, still expandable, when the reply speaks', () => {
  /* THE RULE, accepted by the Controller as the intended choreography.
     Thinking is visible for the whole thinking phase; the moment the reply's
     words begin, the run folds -- folded, not gone, and the reader can open
     it again. This is d8f09572's own rule, "fold once readable speech
     arrives", finally applied to speech that actually arrives: while prose was
     withheld, the first word never made speech visible, so the fold never
     fired at the moment a person was reading.
     The fold is src/components.js openStream's push reaching
     `if (activity.hasText) settleActionRuns()`. If this ever needs to change,
     it changes THERE -- never by re-withholding prose, which is the defect
     this file exists to close. */
  const { whileSpeaking, afterCompleteSentence, userOpenedRetained } = observed.scenarios.thinkingBesideSpeech
  assert.equal(whileSpeaking.runOpen, false, 'the run stayed open after the reply began speaking')
  assert.equal(whileSpeaking.thoughtVisible, false)
  assert.equal(afterCompleteSentence.runOpen, false)
  /* Folded, not lost: the reader can open it again and a later delta does not
     take that back. */
  assert.equal(userOpenedRetained, true, 'a run the reader re-opened was folded under them')
})
