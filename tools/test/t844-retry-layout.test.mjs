import assert from 'node:assert/strict'
import test from 'node:test'
import fs, { mkdirSync, mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { testScratchRoot } from '../lib/test-scratch-root.mjs'

const require = createRequire(import.meta.url)
const exec = promisify(execFile)
const DRAFT = 'Retained unsent draft'
const WIDTHS = [320, 768, 1280]
const STATES = ['normal', 'waiting', 'refusal']
const LABELS = ['Retries off', 'Retry accounts', 'Wait for resets']
const DRAFT_SELECTION = { start: 2, end: DRAFT.length - 2 }
const ATTACHMENT_META = { name: 't1033-inert-attachment.png', size: 42 }
const REQUIRED_CONTROLS = ['tier', 'mode', 'effort', 'model', 'retry', 'retryNow', 'sendNow']

async function runT1033() {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const renderer = fileURLToPath(new URL('./helpers/t844-retry-layout-renderer.mjs', import.meta.url))
  const electron = fileURLToPath(new URL('./helpers/t844-retry-layout-electron.cjs', import.meta.url))
  const base = testScratchRoot('t844-retry-layout-')
  mkdirSync(base, { recursive: true })
  const data = mkdtempSync(join(base, 'run-'))
  const env = (() => {
    const { prepareSterileProfile, sterileProfileDirectories, sterileLaunchEnvironment } = require('../lib/sterile-launch.cjs')
    const sterile = sterileProfileDirectories(join(data, 'environment'))
    const result = sterileLaunchEnvironment(prepareSterileProfile(sterile))
    for (const key of Object.keys(result)) if (/^NODE_OPTIONS$/i.test(key)) delete result[key]
    return result
  })()
  const esbuild = require('esbuild')
  try {
    const buildResult = await esbuild.build({
      entryPoints: [renderer],
      bundle: true,
      format: 'iife',
      outfile: join(data, 'fixture.js'),
      metafile: true,
      loader: { '.woff2': 'dataurl' },
      logLevel: 'silent',
    })
    fs.writeFileSync(
      join(data, 'metafile.json'),
      JSON.stringify(buildResult.metafile, null, 2) + '\n',
    )
    fs.writeFileSync(
      join(data, 'index.html'),
      '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; font-src data:; img-src data:"><title>T1033 retry layout</title><link rel="stylesheet" href="./fixture.css"><body><script src="./fixture.js"></script></body>\n',
    )
    let execution
    try {
      execution = await exec(require('electron'), [electron, data], {
        cwd: root,
        env,
        windowsHide: true,
        timeout: 120000,
        maxBuffer: 1024 * 1024,
      })
    } catch (error) {
      fs.writeFileSync(join(data, 'execution.json'), JSON.stringify({
        error: { message: error.message, code: error.code, signal: error.signal },
        stdout: error.stdout,
        stderr: error.stderr,
      }, null, 2) + '\n')
      throw new Error('T1033 Electron helper failed; retained evidence: ' + data, { cause: error })
    }
    fs.writeFileSync(join(data, 'execution.json'), JSON.stringify(execution, null, 2) + '\n')
    const observations = JSON.parse(fs.readFileSync(join(data, 'observations.json'), 'utf8'))
    return { data, observations }
  } finally {
    esbuild.stop()
  }
}

function assertContained(sample, label) {
  assert.equal(sample.overflow.clear, true, label + ' has horizontal overflow')
  assert.equal(sample.overflow.rootWithinViewport, true, label + ' leaves the viewport')
  assert.equal(sample.allContained, true, label + ' has a control outside the chat')
  assert.equal(sample.requiredContained, true, label + ' has a required control missing or outside the chat')
  assert.equal(sample.requiredVisible, true, label + ' has a required control missing or hidden')
  assert.deepEqual(sample.overlaps, [], label + ' has overlapping controls')
}

test('T1033 actual buildChat retry controls stay contained and preserve a draft in an isolated browser', async t => {
  const { data, observations } = await runT1033()
  t.diagnostic('Retained T1033 fixture/profile/observations: ' + data)
  const attachment = { path: join(data, 'retained', 't1033-inert-attachment.png'), ...ATTACHMENT_META }
  assert.equal(observations.failure, undefined)
  assert.equal(observations.windowsCreated, 1)
  assert.equal(observations.providerCalls, 0)
  assert.deepEqual(observations.deniedRequests, [])
  assert.equal(observations.tabLimit, 12)
  assert.deepEqual(observations.pageErrors, [])
  assert.equal(observations.visible, false)
  assert.equal(observations.offscreen, true)
  assert.equal(observations.closed, true)
  assert.equal(observations.destroyed, true)
  assert.deepEqual(observations.rows.map(row => [row.requestedWidth, row.state]), [
    [320, 'normal'], [320, 'waiting'], [320, 'refusal'],
    [768, 'normal'], [768, 'waiting'], [768, 'refusal'],
    [1280, 'normal'], [1280, 'waiting'], [1280, 'refusal'],
  ])

  for (const row of observations.rows) {
    const label = row.requestedWidth + '/' + row.state
    assertContained(row.initial, label + ' initial')
    assertContained(row.after, label + ' after')
    for (const control of REQUIRED_CONTROLS) {
      assert.equal(row.initial.requiredControls[control].visible, true, label + ' missing ' + control)
      assert.equal(row.after.requiredControls[control].visible, true, label + ' lost ' + control)
    }
    assert.equal(row.contentFocus.requested, true)
    assert.equal(typeof row.contentFocus.webContentsFocused, 'boolean')
    assert.equal(typeof row.contentFocus.documentHasFocus, 'boolean')
    assert.equal(row.screenshot, 'screenshots/' + row.requestedWidth + '-' + row.state + '.png')
    assert.ok(fs.statSync(join(data, row.screenshot)).size > 0)
    assert.deepEqual(row.initial.select.options, LABELS)
    assert.equal(row.initial.select.ariaLabel, 'Account retry policy')
    assert.equal(row.initial.status.role, 'status')
    assert.equal(row.initial.status.ariaLive, 'polite')
    assert.equal(row.initial.status.insideLeft, false)
    assert.equal(row.initial.status.insideRight, false)
    assert.equal(row.initial.status.insideChips, true)
    assert.equal(row.initial.status.siblingOfGroups, true)
    assert.equal(row.after.status.insideLeft, false)
    assert.equal(row.after.status.insideRight, false)
    assert.equal(row.after.status.insideChips, true)
    assert.equal(row.after.status.siblingOfGroups, true)
    assert.equal(row.after.draft, DRAFT)
    assert.equal(row.after.input.value, DRAFT)
    assert.deepEqual(row.initial.selection, DRAFT_SELECTION)
    assert.deepEqual(row.after.selection, DRAFT_SELECTION)
    assert.deepEqual(row.after.attachments, [attachment])
    assert.deepEqual(row.after.exported, {
      text: DRAFT,
      attachments: [attachment],
      start: DRAFT_SELECTION.start,
      end: DRAFT_SELECTION.end,
    })
    assert.equal(row.after.attachmentChips.some(text => text.includes(attachment.name)), true)
    assert.equal(row.send.calls.length, 1)
    assert.deepEqual(row.send.calls[0], { text: DRAFT, attachments: [attachment] })
    assert.equal(row.after.status.text, row.initial.status.text)
    if (row.state === 'normal') {
      assert.equal(row.initial.expectedStatus, '')
      assert.equal(row.initial.status.visible, false)
      assert.equal(row.initial.select.value, 'keep')
      assert.equal(row.target, 'wait')
      assert.equal(row.initial.action.disabled, true)
      assert.equal(row.focusedDraft, true)
      assert.equal(row.tabbedToRetry, true)
      assert.equal(row.tabbedBackToRetry, false)
      assert.ok(row.tabSteps >= 1 && row.tabSteps <= observations.tabLimit)
      assert.equal(row.retryNowTriggered, false)
      assert.deepEqual(row.after.changes, ['wait'])
      assert.deepEqual(row.after.nowCalls, [])
      assert.equal(row.after.select.value, 'wait')
      assert.equal(row.after.activeElement, 'account-retry')
    } else if (row.state === 'waiting') {
      assert.match(row.initial.expectedStatus, /Waiting for allowance to reset/)
      assert.equal(row.initial.status.visible, true)
      assert.equal(row.initial.select.value, 'wait')
      assert.equal(row.initial.action.disabled, false)
      assert.equal(row.target, 'off')
      assert.equal(row.focusedDraft, true)
      assert.equal(row.tabbedToRetry, true)
      assert.ok(row.tabSteps >= 1 && row.tabSteps <= observations.tabLimit)
      assert.equal(row.retryNowTriggered, true)
      assert.deepEqual(row.after.changes, ['off'])
      assert.deepEqual(row.after.nowCalls, ['try-now'])
      assert.equal(row.after.select.value, 'off')
      assert.equal(row.tabbedBackToRetry, true)
      assert.equal(row.after.activeElement, 'account-retry')
    } else {
      assert.match(row.initial.expectedStatus, /Your retry preference could not be saved/)
      assert.equal(row.initial.status.visible, true)
      assert.equal(row.initial.select.value, 'keep')
      assert.equal(row.initial.select.disabled, true)
      assert.equal(row.initial.action.disabled, true)
      assert.equal(row.focusedDraft, true)
      assert.equal(row.tabbedToRetry, false)
      assert.equal(row.tabbedBackToRetry, false)
      assert.equal(row.tabSteps, null)
      assert.equal(row.retryNowTriggered, false)
      assert.deepEqual(row.after.changes, [])
      assert.deepEqual(row.after.nowCalls, [])
      assert.equal(row.after.activeElement, 'draft')
    }
  }
})
