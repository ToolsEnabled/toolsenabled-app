import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
const { createNodeRecoveryStore } = createRequire(import.meta.url)('../../shell/node-recovery-store.cjs')
import { retryWorld } from './helpers/t844-retry-world.mjs'

// Fresh source module resets computersView's coordinator singleton. This is
// reconstruction evidence, not an Electron process relaunch or real-user pass.
test('T844 each saved policy survives view remount and fresh coordinator reconstruction', async t => {
  const base = fileURLToPath(new URL('../../evidence/controller4-retry_controls-20260922/fixtures/', import.meta.url))
  mkdirSync(base, { recursive: true })
  const directory = mkdtempSync(join(base, 'durability-'))
  let disk = createNodeRecoveryStore({ directory })
  const recoveryBridge = { get: request => disk.get(request), save: request => disk.save(request) }
  const f = await retryWorld(t, { recoveryBridge })
  t.diagnostic('Retained node-recovery fixture: ' + directory)
  let chat = await f.openChat()
  for (const value of ['keep', 'wait', 'off']) {
    await f.choose(chat, value)
    const saved = (await f.record()).retryPolicy
    assert.equal(saved.enabled, value !== 'off')
    if (value !== 'off') assert.equal(saved.waitForReset, value === 'wait')
    await f.mount()
    chat = await f.openChat()
    assert.equal(chat.querySelector('[data-chat-chip="account-retry"]').value, value, 'same coordinator remount: ' + value)
    disk = createNodeRecoveryStore({ directory })
    await f.mount({ fresh: true })
    chat = await f.openChat()
    assert.equal(chat.querySelector('[data-chat-chip="account-retry"]').value, value, 'fresh coordinator reads saved policy: ' + value)
    assert.deepEqual((await f.record()).retryPolicy, saved, 'remount does not rewrite the saved choice')
  }
  assert.deepEqual(f.calls.starts, [])
  assert.deepEqual(f.calls.closes, [])
})

test('T844 Try accounts now preserves the saved choice and is inert when Off', async t => {
  const f = await retryWorld(t)
  let chat = await f.openChat()
  await f.choose(chat, 'keep')
  for (const waitForReset of [false, true]) {
    // A waiting policy is a real persisted state where the explicit action
    // is offered. Keep the node stopped so this fixture starts no provider.
    const record = await f.record()
    record.retryPolicy.waitForReset = waitForReset
    record.retryPolicy.state = 'waiting'
    record.retryPolicy.nextAttemptAt = Date.now() + 3600000
    f.records.set(f.nodeId, structuredClone(record))
    await f.mount({ fresh: true })
    chat = await f.openChat()
    const action = chat.querySelector('[data-chat-chip="account-retry-now"]')
    assert.equal(action.hidden, false)
    assert.equal(action.disabled, false)
    const count = f.calls.saves.length
    action.dispatchEvent({ type: 'click' })
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.ok(f.calls.saves.length > count, 'the explicit action reaches keepTryingAccounts')
    const policy = (await f.record()).retryPolicy
    assert.equal(policy.enabled, true)
    assert.equal(policy.waitForReset, waitForReset, 'Try now does not change reset preference')
    assert.deepEqual(policy.allowedProviders, record.retryPolicy.allowedProviders)
  }
  await f.choose(chat, 'off')
  const count = f.calls.saves.length
  const action = chat.querySelector('[data-chat-chip="account-retry-now"]')
  assert.equal(action.hidden, true)
  action.dispatchEvent({ type: 'click' })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(f.calls.saves.length, count, 'Off cannot start a retry through a retained action')
  assert.deepEqual(f.calls.starts, [])
  assert.deepEqual(f.calls.closes, [])
})
