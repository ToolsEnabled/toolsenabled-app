import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { assertBuildProvenance } from '../release-packager/cut-release-candidate.mjs'

const refs = { buildRef: 'a'.repeat(40), engineSourceRef: 'b'.repeat(40) }
const cleanRecord = () => ({
  schemaVersion: 2, dirty: false, overridden: false, ref: refs.buildRef, dirtyFiles: [],
  app: { ref: refs.buildRef, dirty: false, dirtyFiles: [] },
  payload: { resolved: true, ref: refs.engineSourceRef, dirty: false, dirtyFiles: [] },
})

test('release provenance accepts exact clean app and engine refs', () => {
  assert.doesNotThrow(() => assertBuildProvenance(cleanRecord(), refs))
})

test('clean flags cannot certify the wrong source, missing payload or omitted provenance', () => {
  const mutations = [
    record => { record.ref = 'c'.repeat(40) },
    record => { record.app.ref = 'c'.repeat(40) },
    record => { record.payload.ref = 'c'.repeat(40) },
    record => { record.payload.resolved = false },
    record => { record.payload.dirty = true },
    record => { record.overridden = true },
    record => { record.app.dirtyFiles = ['changed.js'] },
    record => { delete record.payload },
    record => { delete record.app.dirtyFiles },
    record => { delete record.schemaVersion },
  ]
  for (const mutate of mutations) {
    const record = cleanRecord()
    mutate(record)
    assert.throws(() => assertBuildProvenance(record, refs), /exact clean application build and engine source refs/)
  }
})

test('Windows path casing cannot turn a refused cutter invocation into success', { skip: process.platform !== 'win32' }, () => {
  const cutter = fileURLToPath(new URL('../release-packager/cut-release-candidate.mjs', import.meta.url)).toUpperCase().replace(/\.MJS$/, '.mjs')
  const result = spawnSync(process.execPath, [cutter, '--not-a-real-flag'], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stderr, /unrecognised argument/)
})
