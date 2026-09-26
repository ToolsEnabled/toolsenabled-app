import assert from 'node:assert/strict'
import test from 'node:test'
import { refusalCode, unavailableReason } from '../../src/agent-availability-copy.js'
import { sendFailureIsUnconfirmed, sendRefusalSentence } from '../../src/fleet-tree-copy.js'
import { retryWorld, settle } from './helpers/t844-retry-world.mjs'

const refusalCodes = ['MC_TRANSCRIPT_DISK_FULL', 'MC_TRANSCRIPT_STORAGE_FAILED', 'MC_TRANSCRIPT_RECOVERY_RESERVE_UNAVAILABLE', 'MC_TRANSCRIPT_ADMISSION_PENDING']
for (const code of refusalCodes) {
  test(code + ' survives IPC and explains the storage refusal before dispatch', () => {
    const received = refusalCode(new Error("Error invoking remote method 'mc-agent:send': Error: " + code))
    assert.equal(received, code)
    assert.equal(sendFailureIsUnconfirmed(received), false)
    assert.match(sendRefusalSentence(received), /disk|storage/i)
    assert.match(sendRefusalSentence(received), /not sent/i)
    assert.match(sendRefusalSentence(received), /retry/i)
    assert.match(unavailableReason(received), /disk|storage/i)
    assert.doesNotMatch(sendRefusalSentence(received), /delivery could not be confirmed/i)
  })
}

for (const code of refusalCodes) test(code === 'MC_TRANSCRIPT_DISK_FULL'
  ? 'real mounted Computers chat retains exact draft and visible disk refusal after a refused send'
  : code + ' keeps the real mounted composer and a definite refusal', async t => {
  const f = await retryWorld(t)
  const attempts = []
  f.world.bridge.send = async request => {
    attempts.push(structuredClone(request))
    throw new Error("Error invoking remote method 'mc-agent:send': Error: " + code)
  }
  const chat = await f.openChat()
  const words = '  Synthetic disk-full question.  '
  chat.importDraft({ text: words, attachments: [] })
  const button = chat.querySelector('.chat-send')
  assert.ok(button)
  button.dispatch('click')
  await settle(25)
  assert.equal(attempts.length, 1, 'the actual view reached its send bridge once')
  assert.equal(attempts[0].text, words)
  assert.equal(chat.exportDraft().text, words, 'the input is restored without changing its words')
  assert.match(chat.textContent, /disk|storage/i)
  assert.match(chat.textContent, /not sent/i)
  assert.doesNotMatch(chat.textContent, /delivery could not be confirmed/i)
  await settle(15)
  assert.equal(attempts.length, 1, 'a storage refusal cannot trigger an automatic retry')
  assert.deepEqual(f.calls.starts, [])
  assert.deepEqual(f.calls.closes, [])
})
