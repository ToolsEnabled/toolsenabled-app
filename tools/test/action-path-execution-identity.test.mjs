import test from 'node:test'
import assert from 'node:assert/strict'
import { createActionBuffer, normalizeChatPathIdentity, sessionActivityEvent } from '../../src/agent-session-events.js'
import { installDomStandIn } from './lib/dom-stand-in.mjs'

const changes = () => [
  { path: '/work/Alpha.js', status: 'M', added: 1, removed: 0 },
  { path: '/work/alpha.js', status: 'M', added: 2, removed: 0 },
  { path: '/work/dir\\file.js', status: 'M', added: 3, removed: 0 },
  { path: '/work/dir/file.js', status: 'M', added: 4, removed: 0 },
]
const packet = (files = changes(), call = 'patch-1', sessionId = 'session-a', turnId = 'turn-a') => ({
  sessionId, event: { type: 'tool_call', tool: 'fileChange', toolCallId: call, turnId, payload: { changes: files } },
})

for (const platform of [undefined, null, 'unreported-worker', 'linux']) {
  test(`${platform ?? 'unknown'} execution preserves case and literal backslashes in file counters`, () => {
    const buffer = createActionBuffer({ platform }), source = packet()
    const activity = sessionActivityEvent(source, 'session-a')
    buffer.add(activity, { turnId: 'turn-a' })
    assert.deepEqual(buffer.metrics('turn-a'), { tools: 1, files: 4, added: 10 })
    assert.deepEqual(activity.fileChanges, source.event.payload.changes, 'displayed paths remain exact protocol paths')
    buffer.add(activity, { turnId: 'turn-a' })
    assert.deepEqual(buffer.metrics('turn-a'), { tools: 1, files: 4, added: 10 }, 'replayed patch does not add counters again')
    const later = sessionActivityEvent(packet([changes()[0]], 'patch-2'), 'session-a')
    buffer.add(later, { turnId: 'turn-a' })
    assert.deepEqual(buffer.metrics('turn-a'), { tools: 2, files: 4, added: 11 }, 'a new patch on a held path contributes its real delta')
  })
}

test('unknown execution keeps exact nonblank spelling instead of inventing path equivalence', () => {
  for (const value of [' file.js', 'file.js ', 'a/./file.js', 'a/file.js', 'C:\\dir\\file.js', 'c:/dir/file.js', '//host/share/a']) {
    assert.equal(normalizeChatPathIdentity(value), value)
  }
  assert.equal(normalizeChatPathIdentity('  '), null)
  assert.equal(normalizeChatPathIdentity(null), null)
})

test('explicit Linux path normalization preserves legal backslash and space characters', () => {
  assert.equal(normalizeChatPathIdentity('/work/dir\\file.js', 'linux'), '/work/dir\\file.js')
  assert.equal(normalizeChatPathIdentity('dir\\..\\file.js', 'linux'), 'dir\\..\\file.js')
  assert.equal(normalizeChatPathIdentity(' file.js ', 'linux'), ' file.js ')
  assert.equal(normalizeChatPathIdentity('C:/../file.js', 'linux'), 'file.js', 'a colon-bearing POSIX directory is not a drive root')
  assert.equal(normalizeChatPathIdentity('/work/src/../file.js', 'linux'), '/work/file.js')
  assert.equal(normalizeChatPathIdentity('/../escape.js', 'linux'), null)
})

test('explicit Windows alias behavior remains available without applying it to unknown workers', () => {
  const files = [
    { path: 'C:\\Work\\src\\A.js', status: 'M', added: 4, removed: 1 },
    { path: 'c:/work/src/a.js', status: 'M', added: 90, removed: 80 },
  ]
  const activity = sessionActivityEvent(packet(files), 'session-a')
  const windows = createActionBuffer({ platform: 'win32' })
  windows.add(activity, { turnId: 'turn-a' }); windows.add(activity, { turnId: 'turn-a' })
  assert.deepEqual(windows.metrics('turn-a'), { tools: 1, files: 1, added: 4, removed: 1 })
  const unknown = createActionBuffer()
  unknown.add(activity, { turnId: 'turn-a' })
  assert.deepEqual(unknown.metrics('turn-a'), { tools: 1, files: 2, added: 94, removed: 81 })
  assert.equal(normalizeChatPathIdentity('\\\\Host\\Share\\src\\..\\A.js', 'win32'), '//host/share/a.js')
  assert.equal(normalizeChatPathIdentity('C:\\..\\escape.js', 'win32'), null)
})

for (const viewingPlatform of ['win32', 'linux']) test(`actual standalone session counters do not inherit viewing host ${viewingPlatform}, including restart`, async t => {
  const { document, restore } = installDomStandIn(globalThis)
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => key === 'mc.write.agent-session' ? 'enabled' : null, setItem() {}, removeItem() {},
  } })
  window.mcSetup = { platform: viewingPlatform }
  let dispose, control, listener, sessionId, turns = 0
  t.after(() => {
    dispose?.(); restore()
    if (prior) Object.defineProperty(globalThis, 'localStorage', prior)
    else delete globalThis.localStorage
  })
  const bridge = {
    availability: async () => ({ ok: true }),
    onEvent(fn) { listener = fn; return () => {} },
    async start(request) { sessionId = request.sessionId; return { ok: true, sessionId } },
    async send() { return { ok: true, turnId: `turn-${++turns}` } },
    close: async () => ({ ok: true }), interrupt: async () => ({ ok: true }),
  }
  const { mountAgentSessionSurface } = await import('../../src/agent-session.js')
  const root = document.createElement('div'); document.body.appendChild(root)
  dispose = mountAgentSessionSurface(root, { live: true, chatComposer: true, agentId: 'path-identity-test', bridge,
    onController(value) { control = value } })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal((await control.send('Test the reported file changes.')).ok, true)
  for (let turn = 1; turn <= 2; turn++) {
    const event = packet(changes(), `patch-${turn}`, sessionId, `turn-${turn}`)
    listener(event); listener(event)
    const counters = root.querySelector('[data-chat-working-counters]')
    assert.ok(counters, 'the mounted real working row receives action-buffer metrics')
    assert.match(counters.getAttribute('aria-label'), /4 files touched/)
    assert.match(counters.getAttribute('aria-label'), /10 lines added/)
    if (turn === 1) assert.equal((await control.respawn()).ok, true)
  }
})
