import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { performance } from 'node:perf_hooks'
import { createUsageRecorder } from '../../shell/usage-record.cjs'
import { createSpawnRecorder } from '../../shell/spawn-record.cjs'

const keystore = {
  isEncryptionAvailable: () => true,
  encryptString: text => Buffer.from(`fixture:${Buffer.from(text).toString('base64')}`),
  decryptString: bytes => Buffer.from(bytes.toString().slice('fixture:'.length), 'base64').toString(),
}
function workspace(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-responsive-'))
  t.after(() => fs.rmSync(directory, { recursive:true, force:true }))
  return directory
}
const turn = index => ({sessionId:`session-${index}`,turnId:`turn-${index}`,
  usage:{inputTokens:index,outputTokens:2,totalTokens:index+2}})

test('a cold usage read lets the event loop run between real signature checks', async t => {
  const directory=workspace(t)
  const writer=createUsageRecorder({safeStorage:keystore,directory})
  for(let index=0;index<2048;index++) writer.recordTurn(turn(index))
  const reader=createUsageRecorder({safeStorage:keystore,directory})
  let pulse=0, stopped=false, scheduled, maxHeartbeatGapMs=0, lastHeartbeat=performance.now()
  const pulseLoop=()=>{
    if(stopped)return
    const now=performance.now()
    maxHeartbeatGapMs=Math.max(maxHeartbeatGapMs,now-lastHeartbeat)
    lastHeartbeat=now;pulse++;scheduled=setImmediate(pulseLoop)
  }
  scheduled=setImmediate(pulseLoop)
  const original=crypto.verify, observedPulses=new Set()
  let checks=0
  crypto.verify=(...args)=>{checks++;observedPulses.add(pulse);return original(...args)}
  const started=performance.now()
  let answer
  try {
    // The old public read is the causal control before the asynchronous API
    // exists: a mere resolved Promise around that call does not release UI work.
    answer=await (reader.usageAsync ? reader.usageAsync({limit:2}) : Promise.resolve(reader.usage({limit:2})))
  } finally {
    crypto.verify=original;stopped=true;clearImmediate(scheduled)
    maxHeartbeatGapMs=Math.max(maxHeartbeatGapMs,performance.now()-lastHeartbeat)
  }
  t.diagnostic(JSON.stringify({bytes:fs.statSync(writer.ledgerPath).size,checks,
    verificationTurns:observedPulses.size,maxHeartbeatGapMs,durationMs:performance.now()-started}))
  assert.equal(answer.verified,true)
  assert.equal(answer.total,2048)
  assert.equal(checks,2048,'every signature is still checked on a cold read')
  assert.ok(observedPulses.size>1,'verification must release the event loop before the last signature')
  assert.deepEqual(answer.entries.map(entry=>entry.usage.turnId),['turn-2047','turn-2046'])
})

test('async history keeps exact-byte tamper detection and incremental append verification', async t => {
  const directory=workspace(t)
  const writer=createSpawnRecorder({safeStorage:keystore,directory})
  for(let index=0;index<40;index++)writer.record({action:'agent_session_start',sessionId:`session-${index}`})
  const reader=createSpawnRecorder({safeStorage:keystore,directory})
  assert.equal(typeof reader.historyAsync,'function')
  const first=await reader.historyAsync({limit:2})
  assert.equal(first.verified,true)
  assert.equal(reader.stats().signatureChecks,40)
  assert.deepEqual(await reader.historyAsync({limit:2}),first)
  assert.equal(reader.stats().signatureChecks,40,'unchanged bytes reuse the measured verdict')
  writer.record({action:'agent_session_start',sessionId:'session-40'})
  assert.equal((await reader.historyAsync()).total,41)
  assert.equal(reader.stats().signatureChecks,41,'only the real append needs another signature check')
  const stat=fs.statSync(writer.ledgerPath),original=fs.readFileSync(writer.ledgerPath,'utf8')
  const tampered=original.replace('session-0','session-x')
  assert.notEqual(tampered,original)
  assert.equal(Buffer.byteLength(tampered),stat.size)
  fs.writeFileSync(writer.ledgerPath,tampered)
  fs.utimesSync(writer.ledgerPath,stat.atime,stat.mtime)
  const changed=await reader.historyAsync()
  assert.equal(changed.verified,false,'a same-size rewrite with restored mtime cannot reuse a good verdict')
  assert.deepEqual(changed,reader.history())
})

test('async usage preserves empty and unreadable answers and the caller limit', async t => {
  const directory=workspace(t),reader=createUsageRecorder({safeStorage:keystore,directory})
  assert.equal(typeof reader.usageAsync,'function')
  assert.deepEqual(await reader.usageAsync(),reader.usage())
  reader.recordTurn(turn(0));reader.recordTurn(turn(1))
  assert.deepEqual(await reader.usageAsync({limit:1}),reader.usage({limit:1}))
  fs.rmSync(reader.ledgerPath)
  fs.mkdirSync(reader.ledgerPath)
  const bad=await reader.usageAsync()
  assert.equal(bad.ok,false)
  assert.equal(typeof bad.code,'string')
})
