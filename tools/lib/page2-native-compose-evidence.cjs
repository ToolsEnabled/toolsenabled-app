'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')

function ownedComposeRecord(paths, name) {
  assert.ok(['session-profiles.json', 'agent-spawn-records.jsonl'].includes(name))
  const relative = path.relative(paths.qaRoot, paths.userData)
  assert.ok(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`),
    'Compose evidence must read only this owned QA user-data directory')
  let current = paths.qaRoot
  for (const part of ['', ...relative.split(path.sep)]) {
    if (part) current = path.join(current, part)
    const stat = fs.lstatSync(current)
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Compose evidence cannot follow a redirected profile directory')
  }
  const file = path.join(paths.userData, name)
  let stat
  try { stat = fs.lstatSync(file) } catch (error) {
    if (error.code === 'ENOENT') return { name, exists: false, bytes: 0, sha256: sha('') }
    throw error
  }
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 64 * 1024 * 1024,
    'Compose evidence requires one bounded regular owned record')
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    const opened = fs.fstatSync(fd)
    assert.ok(opened.isFile() && opened.nlink === 1 && opened.size <= 64 * 1024 * 1024)
    const bytes = fs.readFileSync(fd)
    return { name, exists: true, bytes: bytes.length, sha256: sha(bytes) }
  } finally { fs.closeSync(fd) }
}

async function captureComposeBaseline(context) {
  const saved = await context.page.evaluate(() => {
    const records = []
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)
      if (key?.startsWith('mc.fleet.trees.v1:')) records.push({ key, value: localStorage.getItem(key) })
    }
    return records.sort((left, right) => left.key.localeCompare(right.key))
  })
  const visible = await context.page.locator('.static-tree-node').evaluateAll(nodes => nodes.map(node => ({
    id: node.dataset.agentId, parentId: node.dataset.parentId || null,
  })).sort((left, right) => left.id.localeCompare(right.id)))
  assert.ok(saved.every(row => typeof row.key === 'string' && typeof row.value === 'string'))
  assert.equal(new Set(visible.map(node => node.id)).size, visible.length)
  assert.ok(visible.every(node => typeof node.id === 'string' && node.id))
  return { saved, visible, records: ['session-profiles.json', 'agent-spawn-records.jsonl'].map(name => ownedComposeRecord(context.paths, name)) }
}

function assertComposeUnchanged(before, after) {
  assert.deepEqual(after.saved, before.saved, 'Compose refusal and cancellation must retain the exact saved trees, nodes and profile assignments')
  assert.deepEqual(after.visible, before.visible, 'Compose refusal and cancellation must retain the exact displayed node and parent identities')
  assert.deepEqual(after.records, before.records, 'Compose refusal and cancellation must retain all profile and signed start-ledger bytes')
  // Evidence keeps identities/digests; it does not copy every saved brief.
  return { savedSha256: sha(JSON.stringify(after.saved)), visible: after.visible, records: after.records }
}

module.exports = { ownedComposeRecord, captureComposeBaseline, assertComposeUnchanged }
