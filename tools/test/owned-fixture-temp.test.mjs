import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs'

const owner = 'C:\\Users\\FixtureOwner'
const selected = owner + '\\scratch\\temp'
function boundary({ link, finalPath = selected } = {}) {
  const probes = []
  return { probes, filesystem: {
    lstatSync(value) { probes.push(value); return { isDirectory: () => true, isSymbolicLink: () => value === link } },
    realpathSync: { native(value) { probes.push(value); return finalPath } },
  } }
}

test('fixture temp refuses foreign and ambiguous Windows paths before any IO', () => {
  for (const candidate of [
    'C:\\Users\\Another\\temp', owner + '-other\\temp', owner, 'C:\\Windows\\Temp',
    'C:relative', '\\\\server\\share', '\\\\?\\C:\\Users\\Another\\temp',
    owner + '\\..\\Another\\temp', selected + ':stream', owner + '.\\temp',
  ]) {
    const f = boundary()
    assert.throws(() => ownedFixtureTempRoot({ platform: 'win32', selected: candidate, accountHome: owner, filesystem: f.filesystem }), /Fixture temp/)
    assert.deepEqual(f.probes, [], candidate)
  }
})

test('fixture temp refuses a linked parent before probing its destination or descendants', () => {
  const linked = owner + '\\scratch'
  const f = boundary({ link: linked })
  assert.throws(() => ownedFixtureTempRoot({ platform: 'win32', selected, accountHome: owner, filesystem: f.filesystem }), /not links/)
  assert.equal(f.probes.at(-1), linked)
  assert.equal(f.probes.includes(selected), false)
})

test('fixture temp rejects a changed final path and accepts an ordinary owned Windows path', () => {
  for (const finalPath of ['C:\\Users\\Another\\temp', owner + '\\different']) {
    const f = boundary({ finalPath })
    assert.throws(() => ownedFixtureTempRoot({ platform: 'win32', selected, accountHome: owner, filesystem: f.filesystem }), /path alias/)
  }
  const f = boundary()
  assert.equal(ownedFixtureTempRoot({ platform: 'win32', selected, accountHome: owner, filesystem: f.filesystem }), selected)
})

test('fixture temp creates and removes a real unique child in the selected native temp', () => {
  const root = ownedFixtureTempRoot()
  assert.equal(root, path.resolve(os.tmpdir()))
  const child = fs.mkdtempSync(path.join(root, 'owned-fixture-boundary-'))
  try {
    assert.equal(path.dirname(child), root)
    assert.equal(fs.lstatSync(child).isSymbolicLink(), false)
  } finally {
    fs.rmdirSync(child)
  }
})
