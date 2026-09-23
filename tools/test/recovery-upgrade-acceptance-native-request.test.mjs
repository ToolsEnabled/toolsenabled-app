// Request preparation only: no browser, completed corpus, or product profile is used.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const origin = 'http://127.0.0.1:4601'

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-upgrade-acceptance-request-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const evidence = path.join(directory, 'evidence')
  const output = path.join(directory, 'requests')
  fs.mkdirSync(evidence)
  const report = {
    expectedBase: 'synthetic-candidate', engine: 'synthetic-engine',
    sourceHashes: { 'shell/main.cjs': hash(fs.readFileSync(path.join(root, 'shell/main.cjs'))) },
  }
  const saveReport = () => fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report))
  saveReport()
  // Tiny sentinels exercise packaging/guards; they are not the acceptance corpus.
  for (const name of ['native-seed-21.js', 'native-seed-25.js', 'native-audit.js']) {
    fs.writeFileSync(path.join(evidence, name), '(() => { window.executed = true; return "sentinel"; })()')
  }
  const run = (selectedOrigin = origin) => spawnSync(process.execPath, [
    path.join(root, 'tools/recovery-upgrade-acceptance-native-request.mjs'),
    '--evidence', evidence, '--output', output, '--origin', selectedOrigin,
  ], { encoding: 'utf8', timeout: 10_000 })
  return { output, report, saveReport, run }
}

test('request bundle binds source and payload hashes and refuses overwrite', t => {
  const f = fixture(t)
  const result = f.run()
  assert.equal(result.status, 0, result.stderr)
  const manifest = JSON.parse(fs.readFileSync(path.join(f.output, 'manifest.json')))
  assert.equal(manifest.status, 'PREPARED_ONLY: no native requests executed')
  assert.equal(manifest.engineExecuted, false)
  assert.deepEqual(manifest.sourceHashes, f.report.sourceHashes)
  assert.equal(Object.keys(manifest.files).length, 6)
  const before = new Map(fs.readdirSync(f.output).map(name => [name, fs.readFileSync(path.join(f.output, name))]))
  for (const [name, expected] of Object.entries(manifest.files)) assert.equal(hash(before.get(name)), expected)
  assert.notEqual(f.run().status, 0)
  assert.deepEqual(fs.readdirSync(f.output).sort(), [...before.keys()].sort())
  for (const [name, bytes] of before) assert.deepEqual(fs.readFileSync(path.join(f.output, name)), bytes)
})

test('source mismatch and wrong origin refuse before output creation', t => {
  const f = fixture(t)
  const wrongOrigin = f.run('https://example.invalid')
  assert.notEqual(wrongOrigin.status, 0)
  assert.match(wrongOrigin.stderr, /Expected a product loopback origin/)
  assert.equal(fs.existsSync(f.output), false)
  f.report.sourceHashes['shell/main.cjs'] = '0'.repeat(64)
  f.saveReport()
  const mismatch = f.run()
  assert.notEqual(mismatch.status, 0)
  assert.match(mismatch.stderr, /Saved source mismatch/)
  assert.equal(fs.existsSync(f.output), false)
})

test('generated guards stop wrong targets and preserve an existing capacity key', t => {
  const f = fixture(t)
  const result = f.run()
  assert.equal(result.status, 0, result.stderr)
  for (const name of ['seed-21', 'seed-25', 'audit', 'capacity-write']) {
    const request = JSON.parse(fs.readFileSync(path.join(f.output, `${name}.json`)))
    assert.equal(request.method, 'Runtime.evaluate')
    assert.equal(request.params.awaitPromise, true)
    assert.equal(request.params.returnByValue, true)
    const script = new vm.Script(request.params.expression)
    const window = {}
    assert.throws(() => script.runInNewContext({ window, location: { origin: 'https://example.invalid' } }), /Wrong .*origin/)
    assert.equal(window.executed, undefined)
    if (name === 'audit' || name === 'capacity-write') {
      window.mcPrefs = { file: '/ordinary-profile/renderer-prefs.json' }
      assert.throws(() => script.runInNewContext({ window, location: { origin } }), /Disposable product profile required/)
      assert.equal(window.executed, undefined)
    }
    if (name === 'capacity-write') {
      let writes = 0
      window.mcPrefs.file = '/disposable/recovery-upgrade-acceptance-test/renderer-prefs.json'
      window.mcPrefsNotice = { read: () => null }
      const localStorage = { getItem: () => 'preserve-me', setItem: () => { writes += 1 } }
      assert.throws(() => script.runInNewContext({ window, localStorage, location: { origin } }), /Capacity key already exists/)
      assert.equal(writes, 0)
      assert.equal(localStorage.getItem(), 'preserve-me')
    }
  }
})
