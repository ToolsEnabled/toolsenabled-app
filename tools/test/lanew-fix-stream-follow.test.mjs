// Lane W fix (B): a live stream in the FULL tree conversation must behave the
// way the right-rail chat already does -- follow the reader who is at the
// bottom, and leave alone the reader who scrolled up on purpose. Owner's words:
// "why cant i ever see the thinking". Native mouse wheel, real Computers view,
// hidden sandboxed Electron.
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
const data = fs.mkdtempSync(testScratchRoot('lanew-fix-stream-'))
const env = sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(path.join(data, 'environment'))))
for (const key of Object.keys(env)) if (/^NODE_OPTIONS$/i.test(key)) delete env[key]
const esbuild = require('esbuild')
let observed
try {
  await esbuild.build({ entryPoints: [path.join(root, 'tools/test/helpers/lanew-fix-stream-renderer.mjs')], bundle: true,
    format: 'iife', outfile: path.join(data, 'fixture.js'), loader: { '.woff2': 'dataurl' }, logLevel: 'silent' })
  fs.writeFileSync(path.join(data, 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; font-src data:; img-src data:"><title>Lane W fix stream follow</title><link rel="stylesheet" href="./fixture.css"><body><script src="./fixture.js"></script></body>\n')
  const execution = await promisify(execFile)(require('electron'), [path.join(root, 'tools/test/helpers/lanew-fix-stream-electron.cjs'), data], {
    cwd: root, env, windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024,
  })
  fs.writeFileSync(path.join(data, 'execution.json'), JSON.stringify(execution, null, 2) + '\n')
  observed = JSON.parse(fs.readFileSync(path.join(data, 'observations.json'), 'utf8'))
} finally {
  esbuild.stop()
  console.log('Lane W fix stream-follow evidence: ' + data.replaceAll('\\', '/'))
}

const surface = mode => { const found = observed.surfaces.find(item => item.mode === mode); assert.ok(found, `missing surface ${mode}`); return found }
const stage = (mode, name) => { const s = surface(mode), found = s.stages.find(item => item.name === name); assert.ok(found, `missing stage ${name} (${mode})`); return found.state }

test('the harness stayed hidden, sandboxed and offline', () => {
  assert.equal(observed.failure, undefined, JSON.stringify(observed.failure))
  assert.deepEqual(observed.pageErrors, [])
  assert.deepEqual(observed.deniedRequests, [])
  assert.equal(observed.visible, false)
  assert.equal(observed.destroyed, true)
  assert.deepEqual(observed.surfaces.map(s => s.mode), ['conversation', 'rail'])
})

test('the seeded transcript really overflows, so reading position is a real measurement', () => {
  for (const mode of ['conversation', 'rail']) {
    const seeded = stage(mode, 'seeded')
    assert.ok(seeded.log, `${mode}: no chat log`)
    assert.ok(seeded.log.scrollHeight > seeded.log.clientHeight + 100,
      `${mode}: the transcript must overflow before scrolling means anything: ${JSON.stringify(seeded.log)}`)
  }
})

// THE DEFECT (B). Observed on the candidate: the full conversation parks at the
// top with the "N new below" pill while the rail chat is pinned, so the live
// thinking is below the fold until the pill is pressed.
test('a reader at the bottom is followed by the live stream, in BOTH surfaces', () => {
  for (const mode of ['conversation', 'rail']) {
    const before = stage(mode, 'at-bottom-before-stream')
    assert.equal(before.log.atBottom, true,
      `${mode}: the reader starts at the bottom of a freshly seeded transcript: ${JSON.stringify(before.log)}`)

    const started = stage(mode, 'at-bottom-stream-started')
    const grown = stage(mode, 'at-bottom-stream-grown')

    assert.equal(grown.log.atBottom, true,
      `${mode}: a stream must follow a reader who is at the bottom: ${JSON.stringify(grown.log)}`)
    assert.equal(grown.newBelow?.visible ?? false, false,
      `${mode}: nothing is below the fold, so there is no "new below" pill to show: ${JSON.stringify(grown.newBelow)}`)
    assert.equal(grown.liveTurnInView, true, `${mode}: the live turn must stay in view`)
    /* WHEN the thinking must be in view is when it ARRIVES. Measured on the
       pristine a0618c23 baseline, it is visible and in view at this moment in
       both surfaces, and this guards that. What it deliberately does NOT
       assert is that the thinking is still in view six sentences of reply
       later: by then it has legitimately scrolled above the fold (rail,
       baseline: inView false) and folded itself once readable speech existed
       (d8f09572's rule). Asserting otherwise would pin behaviour the product
       is right not to have. */
    assert.ok(started.thinking.length > 0, `${mode}: the fixture supplied thinking`)
    assert.ok(started.thinking.some(t => t.visible && t.inView),
      `${mode}: supplied thinking must be visible and in view when it arrives: ${JSON.stringify(started.thinking)}`)
    assert.equal(started.log.atBottom, true, `${mode}: the arrival of the stream keeps the reader at the bottom`)
  }
})

// The entry path W3 recorded as observation B: the conversation opened onto an
// existing transcript with the stream already arriving, and parked at the top
// with the pill, so the thinking was below the fold until the pill was pressed.
test('a supplied unfinished reply is visible immediately in both surfaces', () => {
  for (const mode of ['conversation', 'rail']) {
    const fragment = stage(mode, 'at-bottom-reply-fragment')
    assert.equal(fragment.reply?.text, 'An unfinished reply without its ending', mode)
    assert.equal(fragment.reply?.visible, true, `${mode}: reply fragments must not wait for a sentence ending`)
    assert.ok(fragment.thinking.length > 0, `${mode}: the thinking row remains available`)
    assert.equal(fragment.thinking.some(row => row.visible), false,
      `${mode}: readable reply text folds the action group under the decided display contract`)
    assert.equal(fragment.log.atBottom, true, `${mode}: the first reply fragment keeps the reader at the bottom`)
  }
})

test('opening onto a live stream leaves the live turn in view, not below the fold', () => {
  for (const mode of ['conversation', 'rail']) {
    const opened = stage(mode, 'fresh-open-stream')
    const grown = stage(mode, 'fresh-open-stream-grown')
    assert.ok(opened.log.scrollHeight > opened.log.clientHeight + 100,
      `${mode}: the transcript overflows on open: ${JSON.stringify(opened.log)}`)
    assert.equal(grown.log.atBottom, true,
      `${mode}: opening onto a live turn must not park the reader above it: ${JSON.stringify(grown.log)}`)
    assert.equal(grown.liveTurnInView, true, `${mode}: the live turn must be in view on open`)
    /* SCOPE, NAMED: this asserts the READING POSITION only -- that the live
       thinking is inside the transcript viewport rather than below the fold.
       It deliberately does not assert `visible`. Measured separately on the
       pristine a0618c23 baseline, the fresh-open path renders the live
       thinking FOLDED (`{"visible":false,"inView":true}`), which is the
       presentation layer's fold rule. This fresh-open fixture also supplies
       reply text immediately; the separate arrival/fragment stages above
       distinguish visible thinking before speech from folding after speech. */
    assert.ok(grown.thinking.some(t => t.inView),
      `${mode}: the live thinking must be within the transcript viewport on open: ${JSON.stringify(grown.thinking)}`)
  }
})

test('a reader who scrolled up on purpose is left alone, and keeps the pill, in BOTH surfaces', () => {
  for (const mode of ['conversation', 'rail']) {
    const parked = stage(mode, 'scrolled-up-parked')
    assert.equal(parked.log.atBottom, false,
      `${mode}: the native wheel really moved the reader off the bottom: ${JSON.stringify(parked.log)}`)

    const held = stage(mode, 'scrolled-up-after-growth')
    // Without this the rest of the case is vacuous: a pill for nothing new is
    // not a defect, and an earlier run of this fixture measured exactly that.
    assert.ok(surface(mode).grewWhileParked > 0,
      `${mode}: the live turn must really have grown while the reader was parked: grew by ${surface(mode).grewWhileParked}`)
    assert.equal(surface(mode).heldStill, true,
      `${mode}: growth must not steal the scroll from a reader who scrolled up: parked ${parked.log.scrollTop} -> held ${held.log.scrollTop}`)
    assert.equal(held.log.atBottom, false, `${mode}: still parked away from the bottom`)
    assert.equal(held.newBelow?.visible, true,
      `${mode}: a reader parked above the live turn must be offered the way down: ${JSON.stringify(held.newBelow)}`)
  }
})
