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
const data = fs.mkdtempSync(testScratchRoot('role-studio-empty-'))
const env = sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(path.join(data, 'environment'))))
for (const key of Object.keys(env)) if (/^NODE_OPTIONS$/i.test(key)) delete env[key]
const esbuild = require('esbuild')
let observed
try {
  await esbuild.build({ entryPoints: [path.join(root, 'tools/test/helpers/role-studio-empty-renderer.mjs')], bundle: true,
    format: 'iife', outfile: path.join(data, 'fixture.js'), logLevel: 'silent' })
  fs.writeFileSync(path.join(data, 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src data:"><title>Isolated empty role editor</title><link rel="stylesheet" href="./fixture.css"><body><script src="./fixture.js"></script></body>\n')
  const execution = await promisify(execFile)(require('electron'), [path.join(root, 'tools/test/helpers/role-studio-empty-electron.cjs'), data], {
    cwd: root, env, windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024,
  })
  fs.writeFileSync(path.join(data, 'execution.json'), JSON.stringify(execution, null, 2) + '\n')
  observed = JSON.parse(fs.readFileSync(path.join(data, 'observations.json'), 'utf8'))
} finally { esbuild.stop(); console.log('Empty role editor evidence: ' + data.replaceAll('\\', '/')) }
const empty = { owns: '', mustNot: '', handoff: '' }
test('native editor inputs can save cleared directions and create a role with all three fields empty', () => {
  assert.equal(observed.editStatus, 'Role saved.')
  assert.equal(observed.createStatus, 'Role created.')
  assert.deepEqual(observed.loaded, { ...empty, owns: 'Initial responsibility.' })
  for (const fields of [observed.afterEdit, observed.afterCreate]) assert.deepEqual(fields, empty)
  assert.deepEqual(observed.operations, [
    { kind: 'edit', value: { id: 'empty-helper', rules: empty, expectedRevision: 1, functions: ['app.context'], requiresDirectUserAuthorization: true } },
    { kind: 'create', value: { id: 'new-empty-helper', baseDefaultRole: null, rules: empty, functions: null, requiresDirectUserAuthorization: false } },
    { kind: 'edit', value: { id: 'new-empty-helper', rules: { ...empty, owns: 'Refused responsibility.' }, expectedRevision: 1, functions: null, requiresDirectUserAuthorization: false } },
  ])
  assert.equal(observed.roles[0].revision, 2)
  assert.equal(observed.roles[1].revision, 1)
  assert.deepEqual(observed.pageErrors, [])
  assert.deepEqual(observed.deniedRequests, [])
  assert.equal(observed.visible, false)
  assert.equal(observed.destroyed, true)
})

test('role selection announces the actual editor and preserves save or refusal receipts through tabs and reopening', () => {
  assert.equal(observed.canvasStatus, 'Choose a role to start editing.')
  assert.equal(observed.selectedStatus, 'Editing empty-helper.')
  assert.equal(observed.newDraftStatus, 'New role draft.')
  assert.equal(observed.reselectedStatus, 'Editing new-empty-helper.')
  assert.equal(observed.returnedCanvasStatus, 'Choose a role to start editing.')
  assert.equal(observed.closedStatus, 'Workspace closed. Unsaved drafts are kept for this page visit.')
  for (const key of ['savedAfterTab', 'savedAfterSameSelection', 'savedAfterReopen']) assert.equal(observed[key], 'Role saved.', key)
  assert.equal(observed.createdAfterTab, 'Role created.')
  for (const key of ['refusedStatus', 'refusedAfterTab', 'refusedAfterReopen']) assert.equal(observed[key], 'The requested role change was refused.', key)
  assert.deepEqual(observed.refusedDraft, { ...empty, owns: 'Refused responsibility.' })
  assert.equal(observed.roles[1].owns, '')
  assert.equal(observed.roles[1].revision, 1)
})
