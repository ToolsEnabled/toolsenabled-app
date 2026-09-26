import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { NativeAuditReport, selectScenarios, unavailable } from '../lib/page2-native-report.cjs'

test('a failed native prerequisite never becomes an unearned pass or executes its dependent action', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'page2-native-report-'))
  try {
    const report = new NativeAuditReport(directory)
    let dependentRan = false
    await report.run({ id: 'start', title: 'actual start', run: () => { throw new Error('provider refused') } }, {})
    await report.run({ id: 'send', title: 'actual send', requires: ['start'], run: () => { dependentRan = true } }, {})
    assert.equal(dependentRan, false)
    assert.equal(report.exitCode(), 1)
    const saved = JSON.parse(readFileSync(path.join(directory, 'report.json')))
    assert.deepEqual(saved.results.map(row => row.status), ['failed', 'not-run'])
    assert.equal(saved.counts.passed, 0)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('missing native facilities report no verdict and retain the exact reason', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'page2-native-report-'))
  try {
    const report = new NativeAuditReport(directory)
    await report.run({ id: 'picker', title: 'native picker', run: () => unavailable('No interactive desktop') }, {})
    assert.equal(report.exitCode(), 2)
    assert.equal(report.results[0].reason, 'No interactive desktop')
    assert.equal(report.results[0].status, 'unavailable')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('case selection includes ordered prerequisites once and rejects unknown or cyclic cases', () => {
  const cases = [{ id: 'setup' }, { id: 'start', requires: ['setup'] }, { id: 'stop', requires: ['start'] }]
  assert.deepEqual(selectScenarios(cases, ['stop', 'start']).map(row => row.id), ['setup', 'start', 'stop'])
  assert.throws(() => selectScenarios(cases, ['missing']), /Unknown/)
  assert.throws(() => selectScenarios([{ id: 'one', requires: ['two'] }, { id: 'two', requires: ['one'] }]), /Cyclic/)
  assert.throws(() => selectScenarios([{ id: 'one' }, { id: 'one' }]), /unique/)
})
