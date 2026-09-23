import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import path from 'node:path'
const { createVoiceHost } = createRequire(import.meta.url)('../../shell/voice-host.cjs')

function harness({ profileRoot, runtimeDataRoot = 'runtime-data' } = {}) {
  const owner = {}, stranger = {}, calls = [], packets = [], processes = [], ended = []
  const sessions = new Map([['agent', { owner, state: 'ready' }], ['other', { owner: stranger, state: 'ready' }]])
  const host = createVoiceHost({
    appRoot: process.cwd(), profileRoot, sessions, emit: (_owner, packet) => packets.push(packet),
    onEnd: (owner, target) => ended.push({ owner, target }),
    findRuntime: () => ({ python: 'python', worker: 'worker.py', dataRoot: runtimeDataRoot }),
    spawnProcess(command, args, options) {
      const proc = new EventEmitter()
      proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.stdin = new EventEmitter()
      proc.stdin.write = value => { proc.bootstrap = JSON.parse(value); queueMicrotask(() => proc.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'ready', protocolVersion: 1, port: 32123 }) + '\n'))) }
      proc.stdin.end = () => {}; proc.kill = () => { proc.emit('exit', 0) }
      processes.push({ proc, command, args, options }); return proc
    },
    async fetchHttp(url, options) {
      const body = options.body ? JSON.parse(options.body) : null
      calls.push({ url, ...options, parsed: body })
      if (url.includes('/events?')) return new Promise(() => {})
      return { ok: true, status: 200, json: async () => url.endsWith('/sessions') ? { speechEpoch: 0 } : url.endsWith('/interrupt') ? { speechEpoch: 1 } : {} }
    },
  })
  return { host, owner, stranger, sessions, calls, packets, processes, ended }
}

test('worker temporary files stay in the selected runtime data directory', async () => {
  const profileRoot = path.resolve('voice-owner-fixture')
  const runtimeDataRoot = path.join(profileRoot, 'private-instance', 'voice-runtime')
  const h = harness({ profileRoot, runtimeDataRoot })
  try {
    await h.host.start(h.owner, { targetAgentId: 'agent', provider: 'local' })
    const bootstrap = h.processes[0].proc.bootstrap
    assert.equal(bootstrap.profileRoot, profileRoot)
    assert.equal(bootstrap.dataRoot, runtimeDataRoot)
    assert.equal(bootstrap.tempRoot, path.join(runtimeDataRoot, 'temp'))
  } finally { h.host.close() }
})

test('local consent prompts use the bound voice epoch; stopping revokes that contact', async () => {
  const h = harness()
  await h.host.start(h.owner, { targetAgentId: 'agent', provider: 'local' })
  await h.host.announce(h.stranger, 'agent', 'Must not speak')
  await h.host.announce(h.owner, 'other', 'Must not speak')
  assert.ok(!h.calls.some(row => row.url.endsWith('/reply')))
  await h.host.announce(h.owner, 'agent', 'Fixture consent prompt')
  const reply = h.calls.find(row => row.url.endsWith('/reply')).parsed
  assert.equal(reply.text, 'Fixture consent prompt')
  assert.equal(reply.speechEpoch, 1)
  assert.equal(h.packets.at(-1).type, 'accessibility.prompt')
  await h.host.stop(h.owner)
  assert.deepEqual(h.ended, [{ owner: h.owner, target: 'agent' }])
  const count = h.calls.length
  await h.host.announce(h.owner, 'agent', 'Stale prompt')
  assert.equal(h.calls.length, count)
  h.host.close()
})
test('voice targets and session starts obey existing agent ownership', async () => {
  const h = harness()
  assert.deepEqual(h.host.targets(h.owner).map(v => v.sessionId), ['agent'])
  await assert.rejects(h.host.start(h.owner, { targetAgentId: 'other', provider: 'local' }), /VOICE_TARGET_UNAVAILABLE/)
  assert.equal(h.processes.length, 0)
  h.host.close()
})
test('two development runtimes under one account keep worker temporary files separate', async () => {
  const profileRoot = path.resolve('fixture-voice-owner')
  const fixtures = ['dev-a', 'dev-b'].map(name => harness({ profileRoot,
    runtimeDataRoot: path.join(profileRoot, name, 'capability', 'voice-runtime') }))
  try {
    for (const fixture of fixtures) await fixture.host.start(fixture.owner, { targetAgentId: 'agent', provider: 'local' })
    const bootstraps = fixtures.map(fixture => fixture.processes[0].proc.bootstrap)
    for (const bootstrap of bootstraps) {
      assert.equal(bootstrap.profileRoot, profileRoot, 'temporary storage does not weaken the account fence')
      assert.equal(path.dirname(bootstrap.tempRoot), bootstrap.dataRoot, 'worker temporary files belong to this runtime')
      assert.notEqual(bootstrap.tempRoot, path.join(profileRoot, 'AppData', 'Local', 'Temp'), 'the account-wide temporary folder is not reused')
    }
    assert.notEqual(bootstraps[0].tempRoot, bootstraps[1].tempRoot)
  } finally { for (const fixture of fixtures) fixture.host.close() }
})
test('one reserved contact at a time, hidden worker and stdin-only bootstrap', async () => {
  const h = harness()
  const starting = h.host.start(h.owner, { targetAgentId: 'agent', provider: 'local' })
  await assert.rejects(h.host.start(h.stranger, { targetAgentId: 'other', provider: 'local' }), /VOICE_ALREADY_ACTIVE/)
  const bound = await starting
  assert.equal(h.host.allowsMicrophone(h.owner), true)
  assert.equal(h.host.allowsMicrophone(h.stranger), false)
  assert.equal(h.processes[0].options.windowsHide, true)
  assert.equal(h.processes[0].proc.bootstrap.token.length, 64)
  assert.ok(!JSON.stringify(h.processes[0].args).includes(h.processes[0].proc.bootstrap.token))
  await assert.rejects(h.host.offer(h.stranger, { ...bound, type: 'offer', sdp: 'sdp' }), /VOICE_STALE_SESSION/)
  await h.host.stop(h.owner)
  assert.equal(h.host.allowsMicrophone(h.owner), false)
  await assert.rejects(h.host.reply(h.owner, { ...bound, utteranceId: 'u', text: 'stale', speechEpoch: 0 }), /VOICE_STALE_SESSION/)
  h.host.close()
})
test('keys are sent only to speech creation, not replies, argv, or return value', async () => {
  const h = harness(), key = 'test-only-not-a-real-secret'
  const bound = await h.host.start(h.owner, { targetAgentId: 'agent', provider: 'openai', apiKey: key })
  assert.equal(h.calls.find(v => v.url.endsWith('/sessions')).parsed.provider.apiKey, key)
  assert.ok(!JSON.stringify(bound).includes(key))
  assert.ok(!JSON.stringify(h.processes[0].args).includes(key))
  await h.host.reply(h.owner, { ...bound, speechEpoch: 0, utteranceId: 'u', text: 'hello', final: true })
  const reply = h.calls.find(v => v.url.endsWith('/reply'))
  assert.equal(reply.parsed.speechEpoch, 0)
  assert.ok(!reply.body.includes(key))
  h.host.close()
})
test('ending or losing ownership of selected agent refuses further speech requests', async () => {
  const h = harness()
  const bound = await h.host.start(h.owner, { targetAgentId: 'agent', provider: 'local' })
  h.sessions.delete('agent')
  await assert.rejects(h.host.interrupt(h.owner, bound), /VOICE_TARGET_UNAVAILABLE/)
  await h.host.stop(h.owner)
  h.host.close()
})
test('stale generation cannot speak to a replacement contact', async () => {
  const h = harness()
  const old = await h.host.start(h.owner, { targetAgentId: 'agent', provider: 'local' })
  await h.host.stop(h.owner)
  const next = await h.host.start(h.owner, { targetAgentId: 'agent', provider: 'local' })
  assert.ok(next.generation > old.generation)
  await assert.rejects(h.host.reply(h.owner, { ...old, speechEpoch: 0, utteranceId: 'u', text: 'wrong' }), /VOICE_STALE_SESSION/)
  h.host.close()
})
