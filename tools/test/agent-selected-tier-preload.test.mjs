import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'

const preload = readFileSync(new URL('../../shell/fleet-profile-preload.cjs', import.meta.url), 'utf8')

// Execute the installed preload surface; only Electron IPC and its host are inert.
function loadAgentBridge(platform, invoke) {
  const exposed = new Map()
  const calls = []
  const ipcRenderer = {
    sendSync() { return { ok: false, code: 'FIXTURE_BOOTSTRAP_UNAVAILABLE' } },
    send() {},
    on() {},
    removeListener() {},
    invoke(channel, ...args) {
      calls.push({ channel, args })
      return invoke(channel, ...args)
    },
  }
  vm.runInNewContext(preload, {
    process: { platform },
    window: { addEventListener() {} },
    require(name) {
      assert.equal(name, 'electron')
      return {
        contextBridge: { exposeInMainWorld(name, value) { exposed.set(name, value) } },
        ipcRenderer,
      }
    },
  }, { filename: 'fleet-profile-preload.cjs' })
  return { agent: exposed.get('mcAgent'), calls }
}

for (const platform of ['linux', 'win32']) {
  test(platform + ': selected-tier availability crosses the actual preload with ready and refused replies', async () => {
    const replies = [
      { ok: true, tier: 'claude-sonnet', readyProvider: 'claude' },
      { ok: false, tier: 'local', code: 'LOCAL_NODE_RUNTIME_UNAVAILABLE' },
    ]
    const { agent, calls } = loadAgentBridge(platform, async () => replies.shift())
    const chosen = Object.freeze({ tier: 'claude-sonnet' })
    assert.deepEqual(await agent.availability(chosen),
      { ok: true, tier: 'claude-sonnet', readyProvider: 'claude' })
    assert.equal(calls.at(-1).channel, 'mc-agent:availability')
    assert.equal(calls.at(-1).args.length, 1)
    assert.deepEqual({ ...calls.at(-1).args[0] }, { tier: 'claude-sonnet' })
    assert.deepEqual(chosen, { tier: 'claude-sonnet' })

    assert.deepEqual(await agent.availability({ tier: 'local' }),
      { ok: false, tier: 'local', code: 'LOCAL_NODE_RUNTIME_UNAVAILABLE' })
    assert.equal(calls.at(-1).channel, 'mc-agent:availability')
    assert.deepEqual({ ...calls.at(-1).args[0] }, { tier: 'local' })
  })

  test(platform + ': availability without a tier preserves its empty IPC payload', async () => {
    const { agent, calls } = loadAgentBridge(platform, async () => ({ ok: true }))
    for (const args of [[], [undefined], [null]]) {
      assert.deepEqual(await agent.availability(...args), { ok: true })
      assert.equal(calls.at(-1).channel, 'mc-agent:availability')
      assert.equal(calls.at(-1).args.length, 1)
      assert.deepEqual(Object.keys(calls.at(-1).args[0]), [])
    }
  })

  test(platform + ': availability preserves an IPC rejection instead of inventing readiness', async () => {
    const failure = Object.assign(new Error('The work service could not answer.'), { code: 'CAPABILITY_UNAVAILABLE' })
    const { agent } = loadAgentBridge(platform, async () => { throw failure })
    await assert.rejects(agent.availability({ tier: 'claude-sonnet' }),
      error => error.code === failure.code && error.message === failure.message)
  })
}
