import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs'

import { PROOF_SHAPED_NAME, auditBrowserProofs, inspectBrowserProofReceipt, verifyBrowserProofReceipts } from '../check-browser-proofs-discovered.mjs'
import { parseSourceOutput } from '../lib/adapters/source-suites.mjs'
import { SOURCE_COMMAND_ACTIONS } from '../lib/adapters/source-suite-manifests.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const GATE = path.join(REPO_ROOT, 'tools', 'check-browser-proofs-discovered.mjs')
const TEMP_ROOT = ownedFixtureTempRoot()
const REPORTER = { reporter: 'app:browser-proofs' }
const INERT = '// inert browser-proof fixture; never executed\n'
const sha256 = value => createHash('sha256').update(value).digest('hex')

function scaffold(t) {
  const root = mkdtempSync(path.join(TEMP_ROOT, 'check-browser-proofs-'))
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), TEMP_ROOT, 'remove only this fixture-owned temp child')
    assert.ok(!lstatSync(root).isSymbolicLink(), 'never follow a replacement scratch link during cleanup')
    rmSync(root, { recursive: true, force: true })
  })
  const fixtures = path.join(root, 'tools', 'test', 'fixtures')
  mkdirSync(fixtures, { recursive: true })
  copyFileSync(GATE, path.join(root, 'tools', path.basename(GATE)))
  return { root, fixtures, receipts: path.join(root, 'private', 'browser-proof-receipts') }
}
function declare(fixtures, proofs) {
  writeFileSync(path.join(fixtures, 'browser-proofs.json'), JSON.stringify({ schemaVersion: 1,
    families: { tree: { reason: 'hand-run when the surface changes' } }, proofs }, null, 2))
}
function healthy(t) {
  const f = scaffold(t)
  for (const name of ['run-required-proof.mjs', 'run-hand-proof.mjs', 'run-win-proof.mjs']) writeFileSync(path.join(f.fixtures, name), INERT)
  declare(f.fixtures, {
    'run-required-proof.mjs': { coverage: 'required', ledger: 'T-fixture', receipt: 'results.json', reason: 'the one painted check for a fixture fact' },
    'run-hand-proof.mjs': { coverage: 'manual', family: 'tree' },
    'run-win-proof.mjs': { coverage: 'platform-limited', platform: 'win32', reason: 'needs a fixed Windows account' },
  })
  return f
}
function run(root, ...args) {
  return spawnSync(process.execPath, ['tools/check-browser-proofs-discovered.mjs', ...args],
    { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30_000, env: { ...process.env, TEMP: TEMP_ROOT, TMP: TEMP_ROOT } })
}
function receipt(overrides = {}) {
  return { driver: { file: 'tools/test/fixtures/run-required-proof.mjs', sha256: sha256(INERT) }, platform: 'linux', arch: 'x64',
    origin: 'http://127.0.0.1:4600', startedAt: '2026-09-10T00:00:00.000Z', checks: ['a control is styled'], errors: [], defaultLooking: [], outsideRequests: 0, ...overrides }
}
function placeReceipt(f, body) {
  const directory = path.join(f.receipts, 'run-required-proof')
  mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(directory, 'results.json'), typeof body === 'string' ? body : JSON.stringify(body))
}

test('the real tree declares every run-*.mjs driver and the T35 styled-buttons proof is the required one', () => {
  const audit = auditBrowserProofs()
  assert.ok(audit.discovered.length >= 40, `census shrank to ${audit.discovered.length}`)
  for (const name of audit.discovered) assert.match(name, PROOF_SHAPED_NAME)
  assert.deepEqual({ unregistered: audit.unregistered, stale: audit.stale, invalid: audit.invalid, linked: audit.linked }, { unregistered: [], stale: [], invalid: [], linked: [] })
  /* T360/T365 were removed from the owner ledger on 2026-09-22. Their
     historical jelly renderer is not selected by the current Home styles. */
  assert.deepEqual(audit.entries.filter(entry => entry.coverage === 'required').map(entry => entry.name),
    ['run-buttons-carry-app-style.mjs'])
  assert.equal(audit.counts.required + audit.counts.manual + audit.counts.platformLimited, audit.discovered.length)
  assert.equal(audit.receiptsDirectory, 'private/browser-proof-receipts')
})

test('the qualification action runs the receipts mode, discharges the npm test gate and is in every cut wrapper', () => {
  const action = SOURCE_COMMAND_ACTIONS.app.find(row => row.id === 'app:browser-proofs')
  assert.deepEqual(action.command, ['node', 'tools/check-browser-proofs-discovered.mjs', '--receipts', 'private/browser-proof-receipts'])
  assert.deepEqual(action.satisfies, [['node', 'tools/check-browser-proofs-discovered.mjs']])
  assert.equal(action.reporter, 'app:browser-proofs')
  assert.ok(action.measuredInputs.includes('tools/test/fixtures/browser-proofs.json'))
  const scripts = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).scripts
  for (const alias of ['test', 'release:cut', 'release:cut:linux']) assert.ok(scripts[alias].includes('node tools/check-browser-proofs-discovered.mjs'), `${alias} must run the guard`)
})

test('an undeclared driver, a stale declaration and a malformed one each fail the guard by name', t => {
  const f = scaffold(t)
  for (const name of ['run-declared-proof.mjs', 'run-undeclared-proof.mjs', 'run-broken-proof.mjs']) writeFileSync(path.join(f.fixtures, name), INERT)
  declare(f.fixtures, { 'run-declared-proof.mjs': { coverage: 'manual', family: 'tree' }, 'run-gone-proof.mjs': { coverage: 'manual', reason: 'gone' },
    'run-broken-proof.mjs': { coverage: 'sometimes' } })
  const audit = auditBrowserProofs(f.fixtures)
  assert.deepEqual(audit.unregistered, ['run-undeclared-proof.mjs'])
  assert.deepEqual(audit.stale, ['run-gone-proof.mjs'])
  assert.deepEqual(audit.invalid.map(entry => entry.name), ['run-broken-proof.mjs'])
  const result = run(f.root)
  assert.equal(result.status, 1, result.stdout + result.stderr)
  for (const pattern of [/declared NOWHERE/, /run-undeclared-proof\.mjs/, /run-gone-proof\.mjs/, /run-broken-proof\.mjs -- its coverage "sometimes"/]) assert.match(result.stderr, pattern)
})

test('a fixtures directory with no drivers refuses instead of passing blind', t => {
  const f = scaffold(t)
  declare(f.fixtures, {})
  const result = run(f.root)
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stderr, /ZERO run-\*\.mjs drivers/)
})

test('healthy discovery passes and names what is declared but unexecuted; the qualification reporter refuses discovery alone', t => {
  const f = healthy(t)
  const result = run(f.root)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const lines = result.stdout.trim().split('\n')
  assert.equal(lines[0], 'Browser proofs: 3 driver(s) discovered under tools/test/fixtures/; 1 required, 1 manual, 1 platform-limited; 0 unregistered, 0 stale.')
  assert.equal(lines[1], 'Every browser-proof driver is declared in writing; discovered is not executed: 1 required proof(s) unverified (no receipts directory), 1 manual and 1 platform-limited proof(s) unexecuted by declaration.')
  assert.equal(lines.length, 2)
  assert.throws(() => parseSourceOutput(result.stdout, '', REPORTER), /Source qualification incomplete/)
})

test('a required proof without an attributable passing receipt is a failure, never a skip', t => {
  const f = healthy(t)
  const audit = auditBrowserProofs(f.fixtures)
  const judged = () => verifyBrowserProofReceipts(audit, f.receipts)
  const verified = judged()
  assert.deepEqual(verified.obligations.map(row => [row.name, row.kind, row.status]), [['run-required-proof.mjs', 'missing-required-browser-proof', 'unexecuted']])
  assert.deepEqual(verified.unexecuted.map(row => [row.name, row.kind, row.status]),
    [['run-hand-proof.mjs', 'manual-browser-proof', 'unexecuted'], ['run-win-proof.mjs', 'platform-limited-browser-proof', 'unexecuted']])
  let result = run(f.root, '--receipts', 'private/browser-proof-receipts')
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stderr, /not ok - Required proof run-required-proof\.mjs: missing-required-browser-proof/)
  assert.match(result.stderr, /a failure, not a skip/)

  placeReceipt(f, '{not json')
  assert.equal(judged().obligations[0].kind, 'unreadable-browser-proof-receipt')
  placeReceipt(f, receipt({ driver: { file: 'tools/test/fixtures/run-required-proof.mjs', sha256: 'f'.repeat(64) } }))
  assert.equal(judged().obligations[0].kind, 'unattributable-browser-proof')
  placeReceipt(f, receipt({ driver: { file: 'tools/test/fixtures/run-other-proof.mjs', sha256: sha256(INERT) } }))
  assert.equal(judged().obligations[0].kind, 'unattributable-browser-proof')
  placeReceipt(f, receipt({ driver: undefined }))
  assert.equal(judged().obligations[0].kind, 'unattributable-browser-proof')
  placeReceipt(f, receipt({ origin: 'http://example.invalid' }))
  assert.equal(judged().obligations[0].kind, 'unattributable-browser-proof')
  placeReceipt(f, receipt({ errors: ['a control painted as the browser default'] }))
  assert.deepEqual([judged().obligations[0].kind, judged().obligations[0].status], ['failed-browser-proof', 'failed'])
  placeReceipt(f, receipt({ checks: [] }))
  assert.equal(judged().obligations[0].kind, 'failed-browser-proof')
  placeReceipt(f, receipt({ outsideRequests: 2 }))
  assert.equal(judged().obligations[0].kind, 'failed-browser-proof')
  result = run(f.root, '--receipts', 'private/browser-proof-receipts')
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stderr, /failed-browser-proof -- 2 request\(s\) left the loopback origin/)
  // A receipt beside a manual proof changes nothing: manual is never counted.
  const inspected = inspectBrowserProofReceipt({ name: 'run-hand-proof.mjs', coverage: 'required', receipt: 'results.json', ledger: 'none' },
    { fixturesDirectory: f.fixtures, receiptsDirectory: f.receipts })
  assert.equal(inspected.kind, 'missing-required-browser-proof')
  assert.equal(judged().unexecuted.find(row => row.name === 'run-hand-proof.mjs').status, 'unexecuted')
})

test('an attributable passing receipt is an observed pass the qualification reporter accepts, and only that exact report', t => {
  const f = healthy(t)
  placeReceipt(f, receipt())
  const verified = verifyBrowserProofReceipts(auditBrowserProofs(f.fixtures), f.receipts)
  assert.deepEqual(verified.obligations, [])
  assert.deepEqual([verified.required[0].status, verified.required[0].kind, verified.required[0].driverSha256], ['executed', 'observed-pass', sha256(INERT)])
  const result = run(f.root, '--receipts', 'private/browser-proof-receipts')
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const lines = result.stdout.trim().split('\n')
  assert.equal(lines.length, 3)
  assert.match(result.stderr, /browser-proof qualification: GREEN -- exit 0/, 'the verdict and the exit code on one stderr line, for shells that cannot surface a native exit status')
  assert.match(lines[1], /^Required proof run-required-proof\.mjs: observed-pass; receipt private\/browser-proof-receipts\/run-required-proof\/results\.json sha256 [a-f0-9]{64}; driver sha256 [a-f0-9]{64}; platform linux\.$/)
  assert.equal(lines[2], 'Every required browser proof is executed and attributable; 1 manual and 1 platform-limited proof(s) are declared, discovered and unexecuted.')
  assert.deepEqual(parseSourceOutput(result.stdout, '', REPORTER), { tests: 0, passed: 0, failed: 0, skipped: 0, cancelled: 0, todo: 0, notRun: 0 })
  for (const [from, to] of [
    ['observed-pass', 'observed-fail'],
    ['0 unregistered', '1 unregistered'],
    ['1 required, 1 manual', '2 required, 0 manual'],
    ['driver sha256', 'driver sha1'],
    [lines[2], ''],
  ]) assert.throws(() => parseSourceOutput(result.stdout.replace(from, to), '', REPORTER), /Source qualification incomplete/)
  assert.throws(() => parseSourceOutput(result.stdout, 'not ok - something', REPORTER), /Source qualification incomplete/)
})

test('the real T35 driver records the identity its receipt is judged by', () => {
  const source = readFileSync(path.join(REPO_ROOT, 'tools/test/fixtures/run-buttons-carry-app-style.mjs'), 'utf8')
  assert.match(source, /driver: \{ file: 'tools\/test\/fixtures\/run-buttons-carry-app-style\.mjs', sha256: createHash\('sha256'\)/)
  assert.match(source, /platform: process\.platform, arch: process\.arch, startedAt:/)
})
