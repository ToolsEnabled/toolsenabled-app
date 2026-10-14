// Lane W T20: Unqueue must give the person their words back.
//
// Measured before this fix, on both surfaces: pressing Unqueue removed the row
// and left the composer EMPTY, and the up-arrow recall walk only reaches
// entries still IN the queue -- so a message typed while the agent was busy was
// gone for good, for pressing the one door that offers to take it back.
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
const data = fs.mkdtempSync(testScratchRoot('lanew-t20-unqueue-'))
const env = sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(path.join(data, 'environment'))))
for (const key of Object.keys(env)) if (/^NODE_OPTIONS$/i.test(key)) delete env[key]
const esbuild = require('esbuild')
let observed
try {
  await esbuild.build({ entryPoints: [path.join(root, 'tools/test/helpers/lanew-t20-queue-renderer.mjs')], bundle: true,
    format: 'iife', outfile: path.join(data, 'fixture.js'), loader: { '.woff2': 'dataurl' }, logLevel: 'silent' })
  fs.writeFileSync(path.join(data, 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; font-src data:; img-src data:"><title>Lane W T20 unqueue</title><link rel="stylesheet" href="./fixture.css"><body><script src="./fixture.js"></script></body>\n')
  const execution = await promisify(execFile)(require('electron'), [path.join(root, 'tools/test/helpers/lanew-t20-unqueue-electron.cjs'), data], {
    cwd: root, env, windowsHide: true, timeout: 150000, maxBuffer: 2 * 1024 * 1024,
  })
  fs.writeFileSync(path.join(data, 'execution.json'), JSON.stringify(execution, null, 2) + '\n')
  observed = JSON.parse(fs.readFileSync(path.join(data, 'observations.json'), 'utf8'))
} finally {
  esbuild.stop()
  console.log('Lane W T20 unqueue evidence: ' + data.replaceAll('\\', '/'))
}

const surface = mode => { const s = observed.surfaces.find(x => x.mode === mode); assert.ok(s, `missing surface ${mode}`); return s }

test('the harness stayed hidden, sandboxed and offline', () => {
  assert.equal(observed.failure, undefined, JSON.stringify(observed.failure))
  assert.deepEqual(observed.pageErrors, [])
  assert.deepEqual(observed.deniedRequests, [])
  assert.equal(observed.visible, false)
  assert.equal(observed.destroyed, true)
  assert.deepEqual(observed.surfaces.map(s => s.mode), ['conversation', 'rail'])
})

// THE DEFECT.
test('Unqueue puts the exact words back in an empty box, and sends nothing', () => {
  for (const mode of ['conversation', 'rail']) {
    const c = surface(mode).cases.emptyBox
    assert.ok(c, `${mode}: the empty-box case did not run`)
    assert.equal(c.queuedText, observed.expected.queued, `${mode}: the row held the typed words`)
    assert.equal(c.after.value, observed.expected.queued,
      `${mode}: Unqueue must return the exact words to the box, not discard them: ${JSON.stringify(c.after.value)}`)
    assert.deepEqual(c.after.rows.map(r => r.text), [], `${mode}: the row is still removed`)
    assert.deepEqual(c.after.sends, [], `${mode}: Unqueue sends nothing`)
  }
})

// The other half of "do not lose the person's text": a draft already in the box
// belongs to the person too. This file's own recall walk stashes a draft byte
// for byte rather than overwrite it, so Unqueue must not overwrite one either.
test('Unqueue does not overwrite a draft the person already has in the box', () => {
  for (const mode of ['conversation', 'rail']) {
    const c = surface(mode).cases.draftInBox
    assert.ok(c, `${mode}: the draft-in-box case did not run`)
    assert.equal(c.after.value, observed.expected.draft,
      `${mode}: the person's draft must survive Unqueue: ${JSON.stringify(c.after.value)}`)
    assert.deepEqual(c.after.rows.map(r => r.text), [], `${mode}: the row is still removed`)
    assert.deepEqual(c.after.sends, [], `${mode}: Unqueue sends nothing`)
    assert.ok(c.after.notes.some(n => n.includes(observed.expected.queued)),
      `${mode}: the unqueued words must survive somewhere rather than vanish: ${JSON.stringify(c.after.notes)}`)
  }
})

test('the up-arrow recall walk is untouched by this fix', () => {
  for (const mode of ['conversation', 'rail']) {
    const c = surface(mode).cases.recallAfterUnqueue
    assert.ok(c, `${mode}: the recall case did not run`)
    assert.deepEqual(c.rows, ['survivor one'], `${mode}: one queued message survives the unqueue`)
    assert.equal(c.box, 'survivor one',
      `${mode}: up-arrow still walks what is left in the queue: ${JSON.stringify(c.box)}`)
  }
})
