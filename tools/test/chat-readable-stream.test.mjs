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
const data = fs.mkdtempSync(testScratchRoot('chat-readable-stream-'))
const env = sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(path.join(data, 'environment'))))
for (const key of Object.keys(env)) if (/^NODE_OPTIONS$/i.test(key)) delete env[key]
const esbuild = require('esbuild')
let observed
try {
  await esbuild.build({ entryPoints: [path.join(root, 'tools/test/helpers/chat-readable-stream-renderer.mjs')], bundle: true,
    format: 'iife', outfile: path.join(data, 'fixture.js'), loader: { '.woff2': 'dataurl' }, logLevel: 'silent' })
  fs.writeFileSync(path.join(data, 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; font-src data:; img-src data:"><title>Isolated chat layout</title><link rel="stylesheet" href="./fixture.css"><body><script src="./fixture.js"></script></body>\n')
  const execution = await promisify(execFile)(require('electron'), [path.join(root, 'tools/test/helpers/chat-readable-stream-electron.cjs'), data], {
    cwd: root, env, windowsHide: true, timeout: 45000, maxBuffer: 1024 * 1024,
  })
  fs.writeFileSync(path.join(data, 'execution.json'), JSON.stringify(execution, null, 2) + '\n')
  observed = JSON.parse(fs.readFileSync(path.join(data, 'observations.json'), 'utf8'))
} finally {
  esbuild.stop()
  console.log('Chat readability evidence: ' + data.replaceAll('\\', '/'))
}

test('long live answers retain their beginning and ending without a hidden inner window', () => {
  for (const row of observed.rows) {
    assert.ok(row.live.bodyHeight >= row.live.scrollHeight - 1, JSON.stringify(row))
    assert.ok(row.live.first && row.live.last && row.live.busy)
    assert.equal(row.live.innerScrollTop, 0)
  }
})
/* THE RULE CHANGED, AND THESE ASSERTIONS CHANGED WITH IT.
 * The owner's requirement is that a live reply is visible while it streams.
 * src/chat-readable-stream.js now holds only an unclosed fence; ordinary prose
 * is shown as it arrives. The three assertions below used to pin the opposite
 * -- an empty bubble until a sentence ended AND a space followed it -- which
 * made a short or sentence-final answer paint nothing for its whole live turn.
 */
test('the mounted conversation paints every arriving token, not only finished sentences', () => {
  for (const row of observed.rows) {
    assert.deepEqual(row.chunkStages, ['A sentence', 'A sentence arrives.', 'A sentence arrives. Next fragment'])
  }
})

test('native thinking streams readable units in one group and stays fully reachable before and after collapse', () => {
  for (const row of observed.rows) {
    const summary = row.thinkingStream
    assert.deepEqual(summary.stages, ['A thought', 'A thought arrives.', 'A thought arrives. Next fragment'])
    assert.equal(summary.groups, 1)
    assert.match(summary.toolLine, /2 tool calls/)
    assert.equal(summary.openWhileThinking, true)
    assert.equal(summary.folded, true)
    for (const body of [summary.live, summary.finished]) {
      assert.ok(body.first && body.last)
      assert.ok(body.bodyHeight >= body.scrollHeight - 1)
    }
  }
})
test('the first visible word folds the live run, and a run the reader opened stays open', () => {
  /* REPLACED ASSERTION, following an approved product change -- not a
     weakening. This used to read "undisplayed partial speech does not hide
     supplied live thinking": the reply was withheld, so the run above it
     stayed open because no speech ever became visible.
     THE RULE NOW, accepted by the Controller as the intended choreography:
     thinking is visible for the whole thinking phase and folds -- folded and
     still expandable, not gone -- when the reply's words start. That is
     d8f09572's own "fold once readable speech arrives", applied to speech that
     actually arrives. The fold is src/components.js openStream's push reaching
     `if (activity.hasText) settleActionRuns()`; if it ever changes it changes
     there, never by restoring the prose hold. */
  for (const row of observed.rows) {
    assert.equal(row.pendingThinking.pendingVisible.replyText, 'An unfinished reply')
    assert.equal(row.pendingThinking.pendingVisible.runOpen, false)
    assert.equal(row.pendingThinking.pendingVisible.thoughtVisible, false)
    /* Unchanged, and the reason this is still a real guard: the reader's own
       disclosure is never overridden by a later delta. */
    assert.equal(row.pendingThinking.completeSentenceFolded, true)
    assert.equal(row.pendingThinking.userOpenedRetained, true)
  }
})

test('scrolling up to read a live answer survives the next delta', () => {
  for (const row of observed.rows) {
    assert.ok(Math.abs(row.readingBefore - row.readingAfter) <= 1, JSON.stringify(row))
    assert.ok(row.readingAfter < row.live.logScrollHeight - row.live.logHeight - 100)
    assert.ok(row.firstReachable, 'The first paragraph must be reachable while the reply is live')
  }
})
test('finished answers and expanded thinking preserve full text without horizontal overflow', () => {
  for (const row of observed.rows) {
    assert.ok(row.finished.bodyHeight >= row.finished.scrollHeight - 1)
    assert.ok(row.finished.first && row.finished.last && !row.finished.busy)
    assert.ok(row.thought.bodyHeight >= row.thought.scrollHeight - 1)
    assert.ok(row.thought.first && row.thought.last)
    assert.ok(row.horizontalOverflow <= 1)
  }
  assert.deepEqual(observed.rows.map(row => [row.width, row.zoom]), [[844, 1], [600, 1.12]])
  assert.deepEqual(observed.pageErrors, [])
  assert.deepEqual(observed.deniedRequests, [])
  assert.equal(observed.visible, false)
  assert.equal(observed.destroyed, true)
})

/* T404 -- A REPLY THAT STOPS MID-ANSWER MUST NOT STOP SILENTLY.
 *
 * Measured in the same real browser as the rows above, so the CSS cascade is
 * the product's own and not a stand-in. The stream is given a table row that
 * never finishes and then left alone: a stalled session and a truncated reply
 * both look exactly like this to the renderer. What is asserted is what a
 * person can see and read, not how the state is spelled. */
test('a live reply stalled mid-markup names its state on the glass and bounds what it withholds', () => {
  for (const row of observed.rows) {
    const held = row.stallHold
    assert.ok(held.painted > 0, `text that arrived is on the glass: ${JSON.stringify(held)}`)
    assert.equal(held.marked, true, 'the row carries the fact that it is holding text back')
    /* heldChars is the source measure; `painted` is the RENDERED text, which
       markdown normalises, so the two are not the same units and must not be
       subtracted from one another. What matters to a person is that the amount
       withheld is bounded and that most of the answer is already readable. */
    assert.ok(held.heldChars > 0 && held.heldChars <= 240,
      `no more than one reach of arrived text is withheld: ${JSON.stringify(held)}`)
    assert.ok(held.painted > held.arrived / 2,
      `most of what arrived is already readable: ${JSON.stringify(held)}`)
    assert.ok(held.notePresent && held.noteText.trim().length > 0, 'a named note is present for a reader')
  }
})

test('the held note stays silent through an ordinary hold and becomes readable when the hold lasts', () => {
  for (const row of observed.rows) {
    const held = row.stallHold
    assert.equal(held.readableImmediately, false,
      `an ordinary sub-frame hold draws nothing: ${JSON.stringify(held)}`)
    assert.equal(held.readableAfterWait, true,
      `a hold that outlasts a normal packet gap is readable: ${JSON.stringify(held)}`)
    assert.ok(held.noteHeight > 0, 'and it occupies the space it claims')
  }
})

test('a turn that completes paints everything that arrived and stops claiming to hold anything', () => {
  for (const row of observed.rows) {
    const held = row.stallHold
    assert.equal(held.markedAfterClose, false, JSON.stringify(held))
    assert.equal(held.noteAfterClose, false, 'the note goes when there is nothing held')
    assert.ok(held.paintedAfterClose > held.painted, 'the held text is on the glass once the turn ends')
  }
})

/* ITEM 5 -- A CODEX FILE CITATION, CONFIRMED IN THE REAL BROWSER.
 *
 * The unit suite (tools/test/chat-markdown.test.mjs) proves the HTML. It cannot
 * prove that the result READS as a reference rather than as a dead link,
 * because it has no cascade. This is the same Electron fixture as the rows
 * above, with the product's own stylesheets. */
test('a codex file citation reads as words on the page, with no markdown punctuation and no local path', () => {
  for (const row of observed.rows) {
    const seen = row.citation
    assert.equal(seen.present, true, `the citation is rendered: ${JSON.stringify(seen)}`)
    assert.ok(seen.rowText.includes('src/chat-markdown.js'), `the words are on the page: ${JSON.stringify(seen)}`)
    assert.ok(!seen.rowText.includes(']('), `no markdown punctuation on the page: ${JSON.stringify(seen)}`)
    // A drive-letter path, spelled without a regular-expression escape so the
    // pattern cannot be broken by a tool that rewrites this file.
    assert.ok(!seen.rowText.includes(`C:${String.fromCharCode(92)}`),
      `no local path on the page: ${JSON.stringify(seen)}`)
    assert.ok(seen.readable && seen.width > 0 && seen.height > 0, `and it is visible: ${JSON.stringify(seen)}`)
  }
})

test('a citation is visibly not a link, while a real link in the same sentence still is', () => {
  for (const row of observed.rows) {
    const seen = row.citation
    assert.notEqual(seen.tag, 'a', `a local path is not an anchor: ${JSON.stringify(seen)}`)
    assert.equal(seen.linkPresent, true, `the web link survives: ${JSON.stringify(seen)}`)
    assert.equal(seen.linkTag, 'a', 'and it is still an anchor')
    assert.equal(seen.anchors, 1, `exactly one thing in the sentence is pressable: ${JSON.stringify(seen)}`)
    assert.notEqual(seen.decorationStyle, seen.linkDecorationStyle,
      `the two are told apart without reading them: ${JSON.stringify(seen)}`)
  }
})
