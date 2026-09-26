import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readPermissionFlags } from '../lib/page2-native-permission-file-scenarios.cjs'

test('native permission readback uses the durable Storage contract and reads only permission values', () => {
  const saved = new Map([
    ['mc.write.agent-session', 'enabled'],
    ['mc.write.cloud-launch', 'disabled'],
    ['mc.set.theme', 'dark'],
  ])
  const reads = []
  const storage = {
    getItem(key) { reads.push(key); return saved.get(key) ?? null },
    key(index) { return [...saved.keys()][index] ?? null },
    get length() { return saved.size },
  }
  assert.deepEqual(Object.keys(storage).sort(), ['getItem', 'key', 'length'])
  assert.deepEqual(readPermissionFlags(storage), {
    'mc.write.agent-session': 'enabled',
    'mc.write.cloud-launch': 'disabled',
  })
  assert.deepEqual(reads, ['mc.write.agent-session', 'mc.write.cloud-launch'])
  saved.set('mc.write.agent-session', 'disabled')
  assert.equal(readPermissionFlags(storage)['mc.write.agent-session'], 'disabled')
})
