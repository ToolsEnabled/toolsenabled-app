import test from 'node:test'
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs'
import { userInfo } from 'node:os'
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { mkdtemp, lstat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import path from 'node:path'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createSpeechText } from '../../src/voice-speech-text.js'
import { createVoiceController } from '../../src/voice-controller.js'
const require = createRequire(import.meta.url)
const { createAccessibilityHost } = require('../../shell/accessibility-host.cjs')
const { createAccessibilityDesktopAdapter } = require('../../shell/accessibility-desktop.cjs')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const tick = () => new Promise(resolve => setImmediate(resolve))

// Explicitly opt-in: requires installed CUDA speech models and opens a
// disposable native window. No physical microphone or speaker is used.
test('real CUDA speech, WebRTC, local consent broker and native controls', {
  skip: (process.platform !== 'win32' || process.env.TOOLSENABLED_RUN_GPU_SPEECH_PROOF !== '1')
    && 'real CUDA speech, WebRTC and native controls against real hardware. Opt in with TOOLSENABLED_RUN_GPU_SPEECH_PROOF=1 on a Windows machine that has it. Named in RELEASE_SKIP_REGISTER (class: nightly).',
  timeout: 600000,
}, async t => {
  const profile = userInfo().homedir
  const inside = value => path.resolve(value).toLowerCase().startsWith(profile.toLowerCase() + path.sep)
  async function fenced(value) {
    const resolved = path.resolve(value)
    assert.ok(inside(resolved), 'test paths must remain in the current OS account')
    let current = profile
    for (const part of path.relative(profile, resolved).split(path.sep)) {
      current = path.join(current, part)
      const info = await lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw error })
      assert.ok(!info?.isSymbolicLink(), 'test paths cannot follow a link')
    }
    return resolved
  }
  const data = await mkdtemp(path.join(ownedFixtureTempRoot(), 'toolsenabled-accessibility-speech-'))
  const runtime = await fenced(path.resolve(root, '../deps/voice-runtime'))
  const python = await fenced(path.join(runtime, 'venv/Scripts/python.exe'))
  const executable = await fenced(path.join(data, 'ControlFixture.exe'))
  const fixtureSource = await fenced(path.join(root, 'tools/test/helpers/desktop-control-fixture.cs'))
  const smoke = await fenced(path.join(root, 'voice-runtime/smoke_test.py'))
  await promisify(execFile)('C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe', [
    '/nologo', '/target:winexe', '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll',
    '/out:' + executable, fixtureSource,
  ], { windowsHide: true, timeout: 20000 })
  const fixture = spawn(executable, [], { windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] })
  let fixtureOutput = ''
  fixture.stdout.on('data', bytes => { fixtureOutput += bytes.toString() })
  fixture.stderr.on('data', () => {})
  const child = spawn(python, ['-E', '-s', '-u', smoke, '--profile-root', profile,
    '--data-root', runtime, '--temp-root', data, '--probe-stream'], {
    windowsHide: true, cwd: root, stdio: ['pipe', 'pipe', 'pipe'],
  })
  const packets = [], waiting = []
  let ended = false, workerError = '', serial = 0, broker = null
  const finish = () => { for (const next of waiting.splice(0)) next() }
  const exit = new Promise(resolve => child.once('exit', code => { ended = true; finish(); resolve(code) }))
  child.on('error', error => { workerError = error.message; ended = true; finish() })
  child.stderr.on('data', bytes => { workerError = (workerError + bytes.toString()).slice(-4000) })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    const packet = JSON.parse(line)
    packets.push(packet); finish()
    if (packet.step !== 'roundtrip') t.diagnostic(packet.step)
  })
  const receive = async (predicate, timeout = 55000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const found = packets.findIndex(predicate)
      if (found >= 0) return packets.splice(found, 1)[0]
      assert.equal(ended, false, workerError || 'speech worker ended before the requested event')
      await new Promise(resolve => { const done = () => { clearTimeout(timer); const i = waiting.indexOf(done); if (i >= 0) waiting.splice(i, 1); resolve() }; const timer = setTimeout(done, Math.min(1000, deadline - Date.now())); waiting.push(done) })
    }
    throw new Error('Timed out awaiting the generated-speech round trip')
  }
  const roundtrip = async (text, { all = false } = {}) => {
    const id = 'probe-' + ++serial
    child.stdin.write(JSON.stringify({ op: 'roundtrip', id, text }) + '\n')
    const events = (await receive(packet => packet.step === 'roundtrip' && packet.id === id)).events
    if (all) return events
    assert.equal(events.length, 1, 'a control command must be one actual recognized utterance')
    return events[0]
  }
  try {
    const { binding } = await receive(packet => packet.step === 'probe_ready', 300000)
    // Real tracking begins only after both CUDA speech models are ready.
    // Keep those models alive until this independent 400-frame run finishes.
    const handCapacity = process.env.TOOLSENABLED_RUN_HAND_VOICE_PROOF === '1'
      ? promisify(execFile)(process.execPath, [path.join(root, 'tools/benchmark-hand-controls.mjs'), '--sustained'], {
        cwd: root, windowsHide: true, timeout: 110000, maxBuffer: 1024 * 1024,
      }).then(({ stdout }) => ({ value: JSON.parse(stdout.trim()) }), error => ({ error }))
      : null
    const owner = { isDestroyed: () => false }
    const sessions = new Map([[binding.targetAgentId, { owner, ownerKind: 'window', agentId: 'synthetic-owner-agent', state: 'ready' }]])
    const principal = { kind: 'agent-session', sessionId: binding.targetAgentId, agentId: 'synthetic-owner-agent', roleId: 'custom-test-role', expectedRoleRevision: 1 }
    const adapter = createAccessibilityDesktopAdapter({ profileRoot: profile })
    const audit = [], sent = [], queued = []
    broker = createAccessibilityHost({ sessions,
      readBinding: () => ({ enabled: true, roleId: principal.roleId, revision: 1, functions: ['accessibility.propose'] }),
      permissionLevel: () => 'unrestricted', isDirectUserTurn: () => true,
      inspect: (input, mode) => adapter.inspect(input, mode), planAction: (input, mode) => adapter.plan(input, mode),
      audit: async event => audit.push(event),
    })
    const controller = createVoiceController({
      voice: { reply: async () => {}, interrupt: async () => ({ speechEpoch: 0 }) },
      agent: { send: async value => { sent.push(value); return { turnId: 'unexpected' } } },
      queue: { enqueue: (_, text) => { queued.push(text); return { ok: false } }, takeNext: () => null },
    })
    controller.bind(binding)
    const deliver = event => {
      const handled = broker.onVoice(owner, event)
      controller.onVoice({ ...event, accessibilityHandled: handled })
      assert.equal(handled, true, 'the real STT result must be consumed by the local broker: ' + event.text)
    }
    const speak = async text => { const event = await roundtrip(text); deliver(event); await tick(); return event }
    const codeWords = code => [...code].map(n => ['zero','one','two','three','four','five','six','seven','eight','nine'][Number(n)]).join(' ')
    const confirm = async () => {
      const code = broker.state(owner).pending.confirmationCode
      return speak('Confirm action ' + codeWords(code) + '.')
    }
    const waitState = async predicate => {
      for (let attempt = 0; attempt < 300; attempt++) {
        if (predicate(broker.state(owner))) return
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      assert.fail('Consent/action did not reach its expected state: ' + JSON.stringify(broker.state(owner).last))
    }
    deliver(await roundtrip('Enable desktop accessibility.'))
    assert.equal(broker.state(owner).enabled, false)
    assert.ok(broker.state(owner).pending)
    await speak(codeWords(broker.state(owner).pending.confirmationCode) + '.')
    assert.equal(broker.state(owner).enabled, false, 'bare spoken digits are not consent')
    assert.ok(broker.state(owner).pending)
    const actual = broker.state(owner).pending.confirmationCode
    const wrong = String((Number(actual) + 1) % 10000).padStart(4, '0')
    await speak('Confirm action ' + codeWords(wrong) + '.')
    assert.equal(broker.state(owner).enabled, false, 'incorrect spoken code cannot opt in')
    await confirm()
    await waitState(state => state.enabled)
    assert.equal(broker.status(principal).pending?.confirmationCode, undefined)
    t.diagnostic('real STT opt-in, bare-code guidance and wrong-code refusal passed')
    const windows = await broker.inspect(principal, {})
    const target = windows.windows.find(row => row.label === 'Mechanical control test')
    assert.ok(target)
    const inspect = await broker.inspect(principal, { windowId: target.id })
    assert.ok(!JSON.stringify(inspect).includes('fixture-secret'))
    const button = inspect.controls.find(row => row.label === 'Test press')
    const field = inspect.controls.find(row => row.actions.includes('type') && row.type === 'Edit')
    assert.ok(button && field)
    await broker.propose(principal, { kind: 'click', targetId: button.id })
    assert.ok(!fixtureOutput.includes('clicked'))
    const actionSpeech = await confirm()
    await waitState(state => !state.busy && !state.pending && state.last?.status === 'completed' && fixtureOutput.includes('clicked'))
    assert.equal((fixtureOutput.match(/clicked/g) || []).length, 1)
    deliver(actionSpeech); await tick()
    assert.equal((fixtureOutput.match(/clicked/g) || []).length, 1, 'replayed speech cannot press again')
    t.diagnostic('real recognized confirmation pressed the native fixture button exactly once')
    await broker.propose(principal, { kind: 'type', targetId: field.id, text: 'Voice authorized fixture text' })
    await confirm()
    await waitState(state => !state.busy && !state.pending && state.last?.status === 'completed' && fixtureOutput.includes('text:Voice authorized fixture text'))
    assert.ok(fixtureOutput.includes('text:Voice authorized fixture text'))
    await speak('Stop accessibility.')
    assert.equal(broker.state(owner).enabled, false)
    await assert.rejects(broker.propose(principal, { kind: 'click', targetId: button.id }), { code: 'ACCESSIBILITY_OFF' })
    assert.equal(sent.length, 0); assert.equal(queued.length, 0)
    assert.equal(audit.filter(event => event.event === 'action-authorized').length, 2)
    const raw = '**Hello there** 😊. Voice is ready.'
    const normalized = createSpeechText().write(raw, true)
    const heard = (await roundtrip(normalized, { all: true })).map(event => event.text).join(' ').toLowerCase()
    assert.match(heard, /hello there/); assert.match(heard, /voice is ready/)
    assert.doesNotMatch(heard, /asterisk|asterik|emoji|smiley|icon/)
    t.diagnostic('real TTS-to-STT formatting, native text entry, emergency stop and no agent forwarding passed')
    if (handCapacity) {
      const result = await handCapacity
      assert.ifError(result.error)
      assert.equal(result.value.ok, true)
      assert.equal(result.value.benchmark.frames, 400)
      assert.equal(result.value.benchmark.detected, 400)
      assert.ok(result.value.benchmark.p95Ms < 45, 'the actual GPU must leave room in the 20 FPS frame budget')
      t.diagnostic('concurrent GPU hand/voice capacity: ' + JSON.stringify(result.value.benchmark))
    }
    broker.close(owner)
    child.stdin.end(JSON.stringify({ op: 'close' }) + '\n')
    assert.equal(await exit, 0, workerError)
  } finally {
    broker?.revokeSession('synthetic-test-agent')
    if (!ended) child.stdin.end(JSON.stringify({ op: 'close' }) + '\n')
    let timer
    try { await Promise.race([exit, new Promise(resolve => { timer = setTimeout(() => { child.kill(); resolve() }, 25000); timer.unref() })]) }
    finally { clearTimeout(timer) }
    lines.close(); fixture.kill()
  }
})
