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
const data = fs.mkdtempSync(testScratchRoot('account-buckets-'))
const env = sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(path.join(data, 'environment'))))
for (const key of Object.keys(env)) if (/^NODE_OPTIONS$/i.test(key)) delete env[key]
const esbuild = require('esbuild')
let observed
try {
  await esbuild.build({ entryPoints: [path.join(root, 'tools/test/helpers/account-buckets-renderer.mjs')],
    bundle: true, format: 'iife', outfile: path.join(data, 'fixture.js'), loader: { '.woff2': 'dataurl' }, logLevel: 'silent' })
  fs.writeFileSync(path.join(data, 'index.html'), `<!doctype html><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src data:; img-src data:">
    <link rel="stylesheet" href="./fixture.css"><body><script src="./fixture.js"></script></body>`)
  const result = await promisify(execFile)(require('electron'), [path.join(root, 'tools/test/helpers/account-buckets-electron.cjs'), data],
    { cwd: root, env, windowsHide: true, timeout: 45000, maxBuffer: 1048576 })
  fs.writeFileSync(path.join(data, 'execution.json'), JSON.stringify(result, null, 2) + '\n')
  observed = JSON.parse(fs.readFileSync(path.join(data, 'observations.json'), 'utf8'))
} finally { esbuild.stop(); console.log('Account bucket layout evidence: ' + data.replaceAll('\\', '/')) }

for (const width of [1120, 600]) test(`${width}px actual Accounts popup preserves separate scopes, precision and readable layout`, () => {
  const row = observed.rows.find(row => row.width === width)
  assert.equal(row.open, true)
  assert.equal(row.overflow, false)
  assert.equal(row.probeCount, 0, 'opening the popup must not check providers')
  assert.equal(row.policyCount, 0)
  assert.equal(row.cards.length, 5)
  assert.deepEqual(row.cards.slice(0, 2).map(card => [card.label, card.token, card.meter]),
    [['gemini-pro', 'REQUESTS', '37.5'], ['gemini-pro', 'TOKENS', '0']])
  assert.equal(row.cards[0].amount, '9007199254740993123456789.125 remaining')
  assert.equal(row.cards[1].amount, '0 remaining')
  assert.equal(row.cards[2].meter, null, 'an amount cannot imply a percentage')
  assert.deepEqual([row.cards[3].label, row.cards[3].token], ['Model not reported', 'Token scope not reported'])
  assert.match(row.cards[4].text, /percentage could not be read/)
  assert.ok(row.cards.every(card => card.accessible))
  assert.ok(row.cards.every(card => card.width >= 210), 'independent scopes should not squeeze into quarter-width cards')
  assert.equal(row.periodBars, 0)
  assert.match(row.allowance, /Some allowance details could not be read/)
})

test('actual popup marks older buckets after a failed check and retires them on sign-in generation change', () => {
  assert.match(observed.invalidation.failed, /Older reading/)
  assert.match(observed.invalidation.failed, /9007199254740993123456789\.125/)
  assert.equal(observed.invalidation.remainingBuckets, 0)
  assert.equal(observed.invalidation.probeCount, 1)
  assert.equal(observed.invalidation.policyCount, 0)
})

test('synthetic native Accounts fixture closes invisibly and makes no external request', () => {
  assert.equal(observed.visible, false)
  assert.equal(observed.destroyed, true)
  assert.deepEqual(observed.pageErrors, [])
  assert.deepEqual(observed.deniedRequests, [])
})
