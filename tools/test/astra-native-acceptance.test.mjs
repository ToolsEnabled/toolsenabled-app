import test from 'node:test'
import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runAstraNativeAcceptance, nativeEvidence, ASTRA_NATIVE_ACCEPTANCE_REFS } from '../astra-native-acceptance.mjs'
import { canonicalRootForTests } from '../canonical-root.mjs'

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const ENGINE_ROOT = process.env.ASTRA_NATIVE_ACCEPTANCE_ENGINE_ROOT
  || canonicalRootForTests()

test('R73/OW31 paired Astra persistence and structured fixture driver', async () => {
  const report = await runAstraNativeAcceptance({ appRoot: APP_ROOT, engineRoot: ENGINE_ROOT })
  assert.equal(report.refs.appBase, ASTRA_NATIVE_ACCEPTANCE_REFS.appBase)
  assert.equal(report.refs.engineBase, ASTRA_NATIVE_ACCEPTANCE_REFS.engineBase)
  assert.equal(report.refs.capabilityRoot, realpathSync(path.join(APP_ROOT, 'capability')))
  assert.equal(report.refs.engineRoot, realpathSync(ENGINE_ROOT))
  assert.equal(report.refs.capabilityBinding, report.refs.capabilityRoot === report.refs.engineRoot ? 'paired-source-link' : 'exact-staged-payload')
  assert.equal(report.fixture.persistence.status, 'passed')
  assert.deepEqual(report.fixture.persistence.cases.slice(0, 3).map(row => row.effort), ['medium', 'high', 'max'])
  assert.deepEqual(
    report.fixture.persistence.cases.filter(row => row.kind === 'changed-stopped-transcript').map(row => [row.from, row.to, row.transcript, row.resume]),
    [['medium', 'high', 'high', 'high'], ['medium', 'max', 'max', 'max']],
  )
  assert.deepEqual(
    report.fixture.persistence.cases.filter(row => row.kind === 'missing-transcript-fallback').map(row => [row.transcript, row.tree, row.resume]),
    [[null, 'high', 'high']],
  )
  assert.equal(report.fixture.structuredLaunch.status, 'passed')
  assert.deepEqual(report.fixture.structuredLaunch.cases.slice(0, 3).map(row => row.structuredEffort), ['medium', 'high', 'max'])
  assert.equal(report.native.status, 'missing')
})

test('native evidence is a separate missing verdict, never a fixture pass', () => {
  const evidence = nativeEvidence()
  assert.equal(evidence.status, 'missing')
  assert.equal(evidence.kind, 'native-provider-evidence-not-run')
  assert.match(evidence.reason, /no paid-provider, live-circle, or Windows claim is made/)
  assert.match(evidence.nextOwner, /Controller/)
})
