import test from 'node:test'
import assert from 'node:assert/strict'

import { launchLinesByOrigin } from '../agent-start-flow-qa.mjs'

const actionFile = { name: 'actions.jsonl', isDirectory: () => false }
const hostLaunch = JSON.stringify({
  action: 'controller.agent.launch',
  details: { surface: 'app.ipc' },
})

test('launch audit distinguishes absence from could-not-tell and retries transient failures', () => {
  const absent = launchLinesByOrigin('/profile', 6, {
    readdirSync() { throw Object.assign(new Error('gone'), { code: 'ENOENT' }) },
  })
  assert.deepEqual(absent, { ok: true, agentHost: 0, bridge: 0 },
    'ENOENT is the one directory error that genuinely means there is no audit tree')

  for (const thrown of [
    Object.assign(new Error('descriptors busy'), { code: 'EMFILE' }),
    Object.assign(new Error('try later'), { code: 'EAGAIN' }),
    Object.assign(new Error('device failed'), { code: 'EIO' }),
    Object.assign(new Error('resource busy'), { code: 'EBUSY' }),
    'not even an Error',
  ]) {
    const result = launchLinesByOrigin('/profile', 6, {
      readdirSync() { throw thrown },
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'LAUNCH_AUDIT_UNAVAILABLE')
    assert.match(result.message, /NOT claiming that no launch exists/)
    assert.equal('agentHost' in result, false, 'could-not-tell must not carry a definite zero tally')
  }

  let reads = 0
  const retryableFilesystem = {
    readdirSync() {
      reads += 1
      if (reads === 1) throw Object.assign(new Error('busy once'), { code: 'EMFILE' })
      return [actionFile]
    },
    statSync() { return { size: hostLaunch.length } },
    readFileSync() { return hostLaunch },
  }
  assert.equal(launchLinesByOrigin('/profile', 6, retryableFilesystem).code, 'LAUNCH_AUDIT_UNAVAILABLE')
  assert.deepEqual(launchLinesByOrigin('/profile', 6, retryableFilesystem),
    { ok: true, agentHost: 1, bridge: 0 },
    'a transient could-not-tell result is neither cached nor latched; the next call pays for and performs the read')
  assert.equal(reads, 2, 'CONTROL: both calls performed directory I/O')
})
