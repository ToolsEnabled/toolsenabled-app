// Independent R114 acceptance preparation. Known-gap witnesses are not release acceptance.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { runAcceptance } from '../recovery-upgrade-acceptance.mjs'

test('R114 historical baseline retains the pre-correction late-drain witnesses', async t => {
  const report = await runAcceptance()
  t.after(() => fs.rmSync(report.directory, { recursive: true, force: true }))
  assert.equal(report.cases.length, 5)
  assert.equal(report.app, '07091006f633d8e452ea9b6a27d0281c88f6249b')
  assert.equal(report.baselineSourceRef, report.app)
  assert.match(report.mode, /Historical pre-correction/)
  assert.deepEqual(report.observations.map(item => item.code), [
    'LATE_DRAIN_RETAINS_SETTINGS_PRESSURE', 'LATE_DRAIN_OVER_BUDGET_INACCESSIBLE',
  ])
  assert.match(report.acceptance, /^OPEN/)
  assert.equal(report.cases[0].firstLaunchRefused, false)
  assert.equal(report.cases[1].firstLaunchRefused, true)
  for (const name of ['before-startup-control', 'late-origin-drain', 'external-capacity-control', 'retained-source-retry']) {
    const fresh = JSON.parse(fs.readFileSync(path.join(report.directory, name, 'relaunch.json')))
    assert.notEqual(fresh.pid, process.pid)
    assert.equal(fresh.setting.ok, true)
  }
  // Exercise seeder refusals without a browser; native execution remains pending.
  const seed = fs.readFileSync(path.join(report.directory, 'native-seed-21.js'), 'utf8')
  class Storage {
    entries = new Map()
    get length() { return this.entries.size }
    getItem(key) { return this.entries.get(key) ?? null }
    setItem(key, value) { this.entries.set(key, value) }
  }
  const localStorage = new Storage()
  const window = { localStorage }
  const scope = { window, localStorage, Storage, location: { origin: 'https://example.invalid' } }
  assert.throws(() => vm.runInNewContext(seed, scope), /Wrong synthetic seed origin/)
  assert.equal(localStorage.length, 0)
  scope.location.origin = 'http://127.0.0.1:4602'
  window.mcPrefs = { available: true }
  assert.throws(() => vm.runInNewContext(seed, scope), /bare native-storage page/)
  assert.equal(localStorage.length, 0)
  delete window.mcPrefs
  assert.equal(vm.runInNewContext(seed, scope).records, 21)
  const preserved = [...localStorage.entries]
  assert.throws(() => vm.runInNewContext(seed, scope), /empty disposable origin/)
  assert.deepEqual([...localStorage.entries], preserved)
})
