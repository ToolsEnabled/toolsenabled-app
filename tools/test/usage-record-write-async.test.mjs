import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createUsageRecorder } from '../../shell/usage-record.cjs'
import { createSpawnRecorder } from '../../shell/spawn-record.cjs'

const keystore = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(`encrypted:${Buffer.from(value).toString('base64')}`),
  decryptString: bytes => Buffer.from(bytes.toString().slice(10), 'base64').toString(),
}
function workspace(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-append-'))
  t.after(() => fs.rmSync(directory, {recursive:true, force:true}))
  return directory
}
const turn = n => ({sessionId:`session-${n}`, turnId:`turn-${n}`, principal:'fixture-owner',
  tier:'claude-opus', status:'success', usage:{inputTokens:n, outputTokens:2, totalTokens:n+2}})

test('cold terminal writes use no synchronous filesystem I/O and preserve queued receipt order', async t => {
  const directory = workspace(t)
  const recorder = createUsageRecorder({safeStorage:keystore,directory})
  const forbidden = ['existsSync','mkdirSync','readFileSync','openSync','writeSync','fsyncSync','closeSync']
  const originals = Object.fromEntries(forbidden.map(name => [name,fs[name]]))
  for (const name of forbidden) fs[name] = () => { throw new Error(`synchronous filesystem call: ${name}`) }
  let receipts
  try { receipts = await Promise.all([1,2,3].map(n => recorder.recordTurnAsync(turn(n)))) }
  finally { Object.assign(fs,originals) }
  assert.deepEqual(receipts.map(r => r.sequence),[1,2,3])
  assert.ok(receipts.every(r => r.signed && r.durable))
  assert.deepEqual(recorder.verify(),{ok:true,count:3})
  const entries = recorder.usage().entries
  assert.deepEqual(entries.map(e => e.usage.turnId),['turn-3','turn-2','turn-1'])
  assert.equal(JSON.parse(fs.readFileSync(recorder.ledgerPath,'utf8').trim().split('\n')[2]).principal,'fixture-owner')
  assert.equal(entries[0].usage.totalTokens,5)
})

test('pending fsync releases the event loop and flush waits for durability', async t => {
  const directory = workspace(t)
  const recorder = createUsageRecorder({safeStorage:keystore,directory})
  // Initialize an ordinary existing installation before delaying its next fsync.
  recorder.recordTurn(turn(1))
  const original = fs.promises.open
  let release, reached
  const atSync = new Promise(resolve => { reached = resolve })
  const gate = new Promise(resolve => { release = resolve })
  fs.promises.open = async (...args) => {
    const handle = await original(...args)
    if (args[0] === recorder.ledgerPath && args[1] === 'a') {
      const sync = handle.sync.bind(handle)
      handle.sync = async () => { reached(); await gate; await sync() }
    }
    return handle
  }
  let write, flush, flushed = false
  try {
    write = recorder.recordTurnAsync(turn(2))
    await atSync
    flush = recorder.flush().then(() => { flushed = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(flushed,false)
    assert.throws(() => recorder.recordTurn(turn(3)),{code:'SPAWN_RECORD_BUSY'})
  } finally {
    release()
    await write
    await flush
    fs.promises.open = original
  }
  assert.equal(flushed,true)
  assert.deepEqual(recorder.verify(),{ok:true,count:2})
})

test('restarted async writer recovers the last line and snapshots queued labels', async t => {
  const directory = workspace(t)
  const first = createUsageRecorder({safeStorage:keystore,directory})
  first.recordTurn(turn(1))
  const next = createUsageRecorder({safeStorage:keystore,directory})
  const input = turn(2)
  const pending = next.recordTurnAsync(input)
  input.usage.totalTokens=999
  input.turnId='changed'
  assert.equal((await pending).sequence,2)
  const history = await next.usageAsync()
  assert.equal(history.verified,true)
  assert.equal(history.entries[0].usage.totalTokens,4)
  assert.equal(history.entries[0].usage.turnId,'turn-2')
})

test('concurrent first-time ledgers publish one shared signing key without replacing it', async t => {
  const directory = workspace(t)
  const usage = createUsageRecorder({safeStorage:keystore,directory})
  const spawn = createSpawnRecorder({safeStorage:keystore,directory})
  await Promise.all([usage.recordTurnAsync(turn(1)),spawn.recordAsync({action:'agent_session_start',sessionId:'spawn-1'})])
  assert.deepEqual(usage.verify(),{ok:true,count:1})
  assert.deepEqual(spawn.verify(),{ok:true,count:1})
  assert.equal(fs.readdirSync(directory).some(name => name.endsWith('.tmp')),false)
})

test('a failed append refuses its receipt and does not strand later writes or flush', async t => {
  const directory = workspace(t)
  const recorder = createUsageRecorder({safeStorage:keystore,directory})
  recorder.recordTurn(turn(1))
  const original = fs.promises.open
  let fail = true
  fs.promises.open = async (...args) => {
    if (fail && args[0] === recorder.ledgerPath && args[1] === 'a') {
      fail=false
      throw Object.assign(new Error('fixture append denied'),{code:'EACCES'})
    }
    return original(...args)
  }
  try {
    const failed = recorder.recordTurnAsync(turn(2))
    const later = recorder.recordTurnAsync(turn(3))
    await assert.rejects(failed,{code:'EACCES'})
    assert.equal((await later).sequence,2)
    await recorder.flush()
  } finally { fs.promises.open = original }
  assert.deepEqual(recorder.verify(),{ok:true,count:2})
  assert.equal(recorder.usage().entries[0].usage.turnId,'turn-3')
})

test('host queues terminal usage and drains it after agents close during shutdown', () => {
  const main = fs.readFileSync(new URL('../../shell/main.cjs',import.meta.url),'utf8')
  assert.match(main,/getUsageRecorder\(\)\.recordTurnAsync\(/)
  assert.match(main,/await host\?\.closeAll\(\)\s+await usageRecorder\?\.flush\(\)/)
})


test('sync and async paths produce identical canonical signatures and preserve existing corrupt-key refusal', async t => {
  const directory = workspace(t)
  const now = () => '2026-09-06T20:00:00.000Z'
  const sync = createSpawnRecorder({safeStorage:keystore,directory,ledgerFile:'sync.jsonl',now})
  const asyncWriter = createSpawnRecorder({safeStorage:keystore,directory,ledgerFile:'async.jsonl',now})
  const input = {action:'agent_turn_usage',sessionId:'fixture-session',principal:'fixture-owner',
    details:{tier:'claude-opus'},usage:turn(1).usage}
  sync.record(input)
  await asyncWriter.recordAsync(input)
  assert.equal(fs.readFileSync(sync.ledgerPath,'utf8'),fs.readFileSync(asyncWriter.ledgerPath,'utf8'))
  const keyBefore = fs.readFileSync(sync.keyPath)
  const refusing = createSpawnRecorder({safeStorage:{...keystore,decryptString:() => {throw new Error('fixture unreadable')}},
    directory,ledgerFile:'refused.jsonl'})
  await assert.rejects(refusing.recordAsync(input),{code:'SPAWN_RECORD_KEY_UNREADABLE'})
  assert.deepEqual(fs.readFileSync(sync.keyPath),keyBefore)
  assert.equal(fs.existsSync(refusing.ledgerPath),false)
})
