/* THE RENDERER'S OWN QUEUE BETWEEN THE BROKER AND THE COMPUTERS VIEW.
 *
 * shell/tree-node-command-broker.cjs holds ONE active slot app-wide and sends
 * the next command only after the previous one is settled -- by the renderer's
 * completion, by its own five-minute deadline, or by a reload. src/main.js
 * mirrors that slot with a latch (`drainingTreeNodeCommand`) around the view's
 * runTreeNodeCommand. The two slots have to agree, and this suite drives the
 * three ways they did not:
 *
 *   1. THE LATCH OUTLIVED THE BROKER'S PATIENCE. The latch was a boolean that
 *      only the in-flight command's own settle could clear. A command that
 *      never settled in the view (a boot that stalls, a start whose transport
 *      never answers) held it for the life of the window. The broker gave up
 *      at its deadline and sent the NEXT command; the renderer queued it behind
 *      the latch and never ran it, so it too expired at the deadline -- and so
 *      did every command after it, five minutes each, until the window
 *      reloaded. The broker sends a new request only once it has answered the
 *      old one, so a new request arriving while the latch is held is proof the
 *      in-flight command has already been answered; the latch must yield to it.
 *
 *   2. AN UNREADABLE REQUEST WAS DROPPED WITHOUT A WORD. cleanTreeNodeCommand
 *      answering null made the onRequest listener return, so nothing ever
 *      called bridge.complete and the waiting assistant sat on the broker's
 *      deadline reading a sentence about a spawn that timed out. The request
 *      id is right there on the raw value; a request this renderer cannot read
 *      is a refusal it can send at once.
 *
 *   3. A VIEW THAT THREW LOST ITS WORDS. `catch {}` turned every thrown error
 *      into the bare code MC_TREE_COMMAND_RENDERER_FAILED, so an assistant was
 *      told "could not add that assistant to the tree (MC_TREE_COMMAND_
 *      RENDERER_FAILED)" and nothing else. The error's own message travels as
 *      `reason` now, and shell/main.cjs puts it in the sentence.
 *
 * src/main.js cannot be imported under node (font and stylesheet assets), so
 * the queue is extracted from the real file and run, in the idiom of
 * tools/test/tree-node-command-clean-gate.test.mjs.
 *
 *   node tools/test/tree-node-command-drain.test.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { FLEET_TREE_LIMITS } from '../../src/fleet-trees.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const mainSource = readFileSync(path.join(repoRoot, 'src', 'main.js'), 'utf8')

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const settle = async (rounds = 6) => { for (let i = 0; i < rounds; i += 1) await tick() }

/* From the queue's first line to the end of the onRequest registration: the
   pending map, the latch, the gate, the completion, the drain, and the
   listener. Extracted, never retyped.

   BOTH BOUNDS ARE DECLARATIONS, NEVER PROSE. The end used to be the sentence
   "// The arrows are the only navigation", which was true only while the
   chevrons WERE the only navigation. Adding the centered text links reworded
   it -- an edit to a comment, in a different feature, that no reviewer would
   read as touching this queue -- and indexOf returned -1, so every one of the
   nine tests in this file failed at once on a line about arrows. A comment
   states a design decision and is rewritten when the decision changes; a
   declaration is the code the slice is actually cutting between. `const RING`
   is the next top-level statement after the listener, so the region ends where
   the queue ends whatever the paragraph above RING happens to say. */
const QUEUE_START = 'const pendingTreeNodeCommands = new Map()'
const QUEUE_END = '\nconst RING = ['

function loadQueue({
  view,
  mcTreeCommand,
  route = { name: 'computers', comp: 'this-computer' },
  firstRun = false,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = () => Date.now(),
  onRender = () => {},
}) {
  const start = mainSource.indexOf(QUEUE_START)
  const end = mainSource.indexOf(QUEUE_END, start)
  assert.ok(start >= 0, `the renderer queue was not found in src/main.js: ${QUEUE_START}`)
  assert.ok(end > start, `the end of the renderer queue was not found in src/main.js: ${QUEUE_END.trim()}`)
  const body = mainSource.slice(start, end)
  const harness = {}
  const windowObject = { mcTreeCommand }
  const location = { hash: `#/computers/${route.comp}` }
  // eslint-disable-next-line no-new-func -- isolating the queue from a file `node --test` cannot import.
  const factory = new Function(
    'FLEET_TREE_LIMITS', 'firstRunPending', 'SETUP_RESOLUTION', 'window', 'location', 'render', 'setTimeout', 'clearTimeout', 'Date', 'harness',
    `let current = { route: ${JSON.stringify(route)}, view: null }
      current.view = harness.view
      ${body}
      harness.drain = drainTreeNodeCommands
      harness.pending = pendingTreeNodeCommands
      harness.latch = () => drainingTreeNodeCommand
      harness.surfaceMounted = markTreeNodeCommandSurfaceMounted
      harness.setCurrent = value => { current = value }`,
  )
  harness.view = view
  factory(FLEET_TREE_LIMITS, () => firstRun, {}, windowObject, location, onRender, setTimer, clearTimer, { now, parse: Date.parse }, harness)
  return harness
}

/* The first thing this file checks is that it can still find the code it
   extracts, and it says so in one sentence. Without it a moved or renamed
   declaration reports as nine unrelated failures about arrows, latches and
   deadlines, and the person reading them has to open the harness to discover
   that no queue was loaded at all. */
test('the harness cuts the renderer queue between two declarations, not between comments', () => {
  const start = mainSource.indexOf(QUEUE_START)
  const end = mainSource.indexOf(QUEUE_END, start)
  assert.ok(start >= 0, `src/main.js no longer declares ${QUEUE_START}`)
  assert.ok(end > start, `src/main.js no longer declares ${QUEUE_END.trim()} after the queue`)
  for (const anchor of [QUEUE_START, QUEUE_END]) {
    assert.doesNotMatch(anchor, /^\s*(\/\/|\/\*)/,
      'a slice anchored on a comment breaks the day someone rewords it; anchor on a declaration')
  }
  const body = mainSource.slice(start, end)
  assert.match(body, /window\.mcTreeCommand\.onRequest\(/,
    'the extracted region must reach the end of the broker listener')
  assert.doesNotMatch(body, /\bconst RING\b/,
    'the ring belongs to the router, not the queue; extracting it drags in imports the harness cannot supply')
})

const REQUEST_A = 'tnc-11111111-1111-4111-8111-111111111111'
const REQUEST_B = 'tnc-22222222-2222-4222-8222-222222222222'
const REQUEST_C = 'tnc-33333333-3333-4333-8333-333333333333'

function createPayload(requestId, overrides = {}) {
  const now = Date.now()
  return {
    protocol: 'toolsenabled.tree-node-command',
    schemaVersion: 1,
    requestId,
    action: 'create-and-start-node',
    computerId: 'this-computer',
    treeId: null,
    nodeId: null,
    expectedSessionId: null,
    parentSessionId: 'chat-parent-1',
    role: 'worker',
    tier: 'claude-sonnet',
    brief: 'Carry out one bounded piece of work.',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 30 * 60 * 1000).toISOString(),
    containsSecretMaterial: false,
    ...overrides,
  }
}

function bridgeStub() {
  const completions = []
  let deliver = null
  return {
    completions,
    request: value => deliver(value),
    mcTreeCommand: {
      onRequest(fn) { deliver = fn; return () => {} },
      async complete(result) { completions.push(result); return { ok: true } },
    },
  }
}

test('a command the view never settles does not hold the next one the broker sends', async () => {
  const bridge = bridgeStub()
  const ran = []
  const view = {
    async runTreeNodeCommand(command) {
      ran.push(command.requestId)
      if (command.requestId === REQUEST_A) return new Promise(() => {}) /* never settles */
      return { ok: true, code: null, nodeId: 'node-2-child', sessionId: 'chat-child-1', threadId: null }
    },
  }
  const queue = loadQueue({ view, mcTreeCommand: bridge.mcTreeCommand })

  bridge.request(createPayload(REQUEST_A))
  await settle()
  assert.deepEqual(ran, [REQUEST_A])
  assert.equal(bridge.completions.length, 0, 'A is genuinely still in flight')

  /* The broker's deadline has passed and it has answered A itself; the only
     way this renderer ever sees B is that A is already settled up there. */
  bridge.request(createPayload(REQUEST_B))
  await settle()
  assert.deepEqual(ran, [REQUEST_A, REQUEST_B], 'B must run: the broker has already given up on A')
  assert.deepEqual(bridge.completions.map(r => [r.requestId, r.ok]), [[REQUEST_B, true]])
  assert.equal(queue.pending.size, 0)
  assert.ok(!queue.latch(), `the latch must be free after B, was ${JSON.stringify(queue.latch())}`)

  /* And a third, ordinary command runs at once behind them. */
  bridge.request(createPayload(REQUEST_C))
  await settle()
  assert.deepEqual(ran, [REQUEST_A, REQUEST_B, REQUEST_C])
})

test('a command retained while Computers mounts is drained once that surface is ready', async () => {
  const bridge = bridgeStub()
  const timers = []
  const ran = []
  const view = {
    async runTreeNodeCommand(command) {
      ran.push(command.requestId)
      return { ok: true, code: null, nodeId: 'node-2-child', sessionId: 'chat-child-1', threadId: null }
    },
  }
  const queue = loadQueue({
    view,
    mcTreeCommand: bridge.mcTreeCommand,
    route: { name: 'home', comp: 'other-computer' },
    setTimer: (callback, delay) => {
      timers.push({ callback, delay })
      return timers.length
    },
    clearTimer: () => {},
  })

  bridge.request(createPayload(REQUEST_A))
  await settle()
  assert.deepEqual(ran, [], 'the command waits while the renderer is routing to its computer')
  assert.equal(queue.pending.size, 1, 'the request stays owned while the surface mounts')
  assert.equal(timers.length, 1,
    'the retained request must schedule a bounded re-drain; otherwise it waits until the broker deadline')
  assert.ok(timers[0].delay > 0 && timers[0].delay <= 30_000, `the re-drain must be bounded, got ${timers[0].delay}`)

  queue.setCurrent({ route: { name: 'computers', comp: 'this-computer' }, view })
  timers.shift().callback()
  await settle()
  assert.deepEqual(ran, [REQUEST_A], 'the mounted Computers surface receives the retained request')
  assert.deepEqual(bridge.completions.map(result => [result.requestId, result.ok]), [[REQUEST_A, true]])
  assert.equal(queue.pending.size, 0)
})

test('a Computers surface that never mounts is refused before the broker deadline', async () => {
  const bridge = bridgeStub()
  const timers = []
  let clock = 1_000
  const view = { async runTreeNodeCommand() { throw new Error('must not run without its surface') } }
  const queue = loadQueue({
    view,
    mcTreeCommand: bridge.mcTreeCommand,
    route: { name: 'home', comp: 'other-computer' },
    setTimer: (callback, delay) => {
      timers.push({ callback, delay })
      return timers.length
    },
    clearTimer: () => {},
    now: () => clock,
  })

  bridge.request(createPayload(REQUEST_A))
  await settle()
  assert.equal(timers.length, 1, 'the retained request has a bounded surface wait')
  clock += 30_000
  timers.shift().callback()
  await settle()

  assert.equal(queue.pending.size, 0)
  assert.deepEqual(bridge.completions.map(result => [result.requestId, result.ok, result.code]), [
    [REQUEST_A, false, 'MC_TREE_COMMAND_SURFACE_UNAVAILABLE'],
  ])
})

test('a request this renderer cannot read is refused at once, by its own id, not left to the deadline', async () => {
  const bridge = bridgeStub()
  const view = { async runTreeNodeCommand() { throw new Error('must not be reached') } }
  loadQueue({ view, mcTreeCommand: bridge.mcTreeCommand })

  bridge.request(createPayload(REQUEST_A, { action: 'no-such-action' }))
  await settle()
  assert.equal(bridge.completions.length, 1, 'an unreadable request is answered, not dropped')
  const [answer] = bridge.completions
  assert.equal(answer.requestId, REQUEST_A)
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'MC_TREE_COMMAND_REQUEST_INVALID')
  assert.equal(answer.sessionId, null)
  assert.equal(typeof answer.reason, 'string')
  assert.ok(answer.reason.length > 0)
})

test('a request with no readable id cannot be answered and is simply not queued', async () => {
  const bridge = bridgeStub()
  const view = { async runTreeNodeCommand() { throw new Error('must not be reached') } }
  const queue = loadQueue({ view, mcTreeCommand: bridge.mcTreeCommand })
  bridge.request({ requestId: 42 })
  bridge.request(null)
  bridge.request('tnc-string-not-object')
  await settle()
  assert.equal(bridge.completions.length, 0)
  assert.equal(queue.pending.size, 0)
})

test('a view that throws hands the engine its words, not only a code', async () => {
  const bridge = bridgeStub()
  const view = { async runTreeNodeCommand() { throw new Error('Only an agent that has not started can be started here.') } }
  loadQueue({ view, mcTreeCommand: bridge.mcTreeCommand })

  bridge.request(createPayload(REQUEST_A))
  await settle()
  assert.equal(bridge.completions.length, 1)
  const [answer] = bridge.completions
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'MC_TREE_COMMAND_RENDERER_FAILED')
  assert.equal(answer.reason, 'Only an agent that has not started can be started here.')
})

test('a view refusal that carries a reason keeps it; a success never carries one', async () => {
  const bridge = bridgeStub()
  const view = {
    async runTreeNodeCommand(command) {
      if (command.requestId === REQUEST_A) {
        return { ok: false, code: 'MC_TREE_COMMAND_START_FAILED', nodeId: 'node-2-child', sessionId: null, threadId: null, reason: 'No launcher for that tier on this computer.' }
      }
      return { ok: true, code: null, nodeId: 'node-3-child', sessionId: 'chat-3', threadId: null, reason: 'never sent on a success' }
    },
  }
  loadQueue({ view, mcTreeCommand: bridge.mcTreeCommand })
  bridge.request(createPayload(REQUEST_A))
  await settle()
  bridge.request(createPayload(REQUEST_B))
  await settle()
  assert.equal(bridge.completions.length, 2)
  assert.equal(bridge.completions[0].reason, 'No launcher for that tier on this computer.')
  assert.equal(Object.prototype.hasOwnProperty.call(bridge.completions[1], 'reason'), false)
})

test('a command arriving after view teardown is retained until the visible tree view remounts', async () => {
  const bridge = bridgeStub()
  let queue
  let retiredCalls = 0
  const replacement = {
    async runTreeNodeCommand(command) {
      return { ok: true, code: null, nodeId: command.nodeId, sessionId: 'replacement-session', threadId: null }
    },
  }
  const retired = {
    async runTreeNodeCommand(command) {
      retiredCalls += 1
      return { ok: false, code: 'MC_TREE_COMMAND_VIEW_DESTROYED', nodeId: command.nodeId, sessionId: null, threadId: null,
        reason: 'The Computers view closed before this request reached its command entry.' }
    },
  }
  queue = loadQueue({
    view: retired,
    onRender: () => setTimeout(() => {
      queue.setCurrent({ route: { name: 'computers', comp: 'this-computer' }, view: replacement })
      queue.surfaceMounted()
      void queue.drain()
    }, 0),
    mcTreeCommand: bridge.mcTreeCommand,
  })
  bridge.request(createPayload(REQUEST_A))
  await settle()
  assert.deepEqual(bridge.completions.map(result => [result.requestId, result.ok, result.sessionId]),
    [[REQUEST_A, true, 'replacement-session']])
  assert.equal(retiredCalls, 1)
  assert.equal(queue.pending.size, 0)
  assert.equal(queue.latch(), null)
})

test('a newer broker request supersedes a deferred remount request before the new view mounts', async () => {
  const bridge = bridgeStub()
  const timers = []
  const clock = { value: 100000 }
  let queue
  let retiredCalls = 0
  const retired = {
    async runTreeNodeCommand(command) {
      retiredCalls += 1
      return { ok: false, code: 'MC_TREE_COMMAND_VIEW_DESTROYED', nodeId: command.nodeId, sessionId: null, threadId: null }
    },
  }
  queue = loadQueue({
    view: retired,
    onRender: () => {},
    setTimer: (callback, delay) => { timers.push({ callback, delay }); return timers.length },
    clearTimer: () => {},
    now: () => clock.value,
    mcTreeCommand: bridge.mcTreeCommand,
  })
  bridge.request(createPayload(REQUEST_A))
  await settle()
  assert.equal(timers[0].delay, 30_000)
  clock.value += 7_000
  bridge.request(createPayload(REQUEST_B))
  await settle()
  assert.equal(retiredCalls, 1)
  assert.equal(queue.pending.size, 1)
  /* No remount: the transferred deadline must now refuse B, not leave the
     reacquisition latch owned by A forever. */
  timers.at(-1).callback()
  await settle()
  assert.deepEqual(bridge.completions.map(result => [result.requestId, result.ok, result.code]),
    [[REQUEST_B, false, 'MC_TREE_COMMAND_SURFACE_UNAVAILABLE']])
  assert.equal(queue.pending.size, 0)
  assert.equal(queue.latch(), null)
  assert.equal(timers.length, 2)
  assert.equal(timers[1].delay, 23_000, 'the superseding request inherits the unchanged absolute deadline')
})

test('a newer broker request supersedes a deferred remount request and the remount runs only B', async () => {
  const bridge = bridgeStub()
  const ran = []
  const retired = {
    async runTreeNodeCommand(command) {
      ran.push(`retired:${command.requestId}`)
      return { ok: false, code: 'MC_TREE_COMMAND_VIEW_DESTROYED', nodeId: command.nodeId, sessionId: null, threadId: null }
    },
  }
  const replacement = {
    async runTreeNodeCommand(command) {
      ran.push(`replacement:${command.requestId}`)
      return { ok: true, code: null, nodeId: command.nodeId, sessionId: 'replacement-session', threadId: null }
    },
  }
  const queue = loadQueue({
    view: retired,
    onRender: () => {},
    setTimer: () => 1,
    clearTimer: () => {},
    mcTreeCommand: bridge.mcTreeCommand,
  })
  bridge.request(createPayload(REQUEST_A))
  await settle()
  bridge.request(createPayload(REQUEST_B))
  await settle()
  queue.setCurrent({ route: { name: 'computers', comp: 'this-computer' }, view: replacement })
  queue.surfaceMounted()
  void queue.drain()
  await settle()
  assert.deepEqual(ran, [`retired:${REQUEST_A}`, `replacement:${REQUEST_B}`])
  assert.deepEqual(bridge.completions.map(result => [result.requestId, result.ok, result.sessionId]),
    [[REQUEST_B, true, 'replacement-session']])
  assert.equal(queue.pending.size, 0)
  assert.equal(queue.latch(), null)
})

test('a deferred remount that never appears refuses after its bounded wait', async () => {
  const bridge = bridgeStub()
  const timers = []
  const retired = {
    async runTreeNodeCommand(command) {
      return { ok: false, code: 'MC_TREE_COMMAND_VIEW_DESTROYED', nodeId: command.nodeId, sessionId: null, threadId: null }
    },
  }
  const queue = loadQueue({
    view: retired,
    onRender: () => {},
    setTimer: (callback, delay) => { timers.push({ callback, delay }); return timers.length },
    clearTimer: () => {},
    mcTreeCommand: bridge.mcTreeCommand,
  })
  bridge.request(createPayload(REQUEST_A))
  await settle()
  assert.equal(timers.length, 1)
  assert.equal(timers[0].delay, 30_000)
  timers[0].callback()
  await settle()
  assert.deepEqual(bridge.completions.map(result => [result.requestId, result.ok, result.code]),
    [[REQUEST_A, false, 'MC_TREE_COMMAND_SURFACE_UNAVAILABLE']])
  assert.equal(queue.pending.size, 0)
})

test('the reason is bounded: a runaway string is cut, a non-string is dropped', async () => {
  const bridge = bridgeStub()
  const view = {
    async runTreeNodeCommand(command) {
      const reason = command.requestId === REQUEST_A ? 'x'.repeat(5000) : { not: 'a string' }
      return { ok: false, code: 'MC_TREE_COMMAND_START_FAILED', nodeId: null, sessionId: null, threadId: null, reason }
    },
  }
  loadQueue({ view, mcTreeCommand: bridge.mcTreeCommand })
  bridge.request(createPayload(REQUEST_A))
  await settle()
  bridge.request(createPayload(REQUEST_B))
  await settle()
  assert.equal(bridge.completions.length, 2)
  assert.ok(bridge.completions[0].reason.length <= 600, `bounded, was ${bridge.completions[0].reason.length}`)
  assert.equal(Object.prototype.hasOwnProperty.call(bridge.completions[1], 'reason'), false)
})

test('an ordinary command still runs one at a time and completes in order', async () => {
  const bridge = bridgeStub()
  let release = null
  const ran = []
  const view = {
    async runTreeNodeCommand(command) {
      ran.push(command.requestId)
      if (command.requestId === REQUEST_A) {
        await new Promise(resolve => { release = resolve })
      }
      return { ok: true, code: null, nodeId: command.requestId, sessionId: 'chat-x', threadId: null }
    },
  }
  const queue = loadQueue({ view, mcTreeCommand: bridge.mcTreeCommand })
  bridge.request(createPayload(REQUEST_A))
  await settle()
  /* The same request id twice is one request: the broker's own duplicate-wake
     memory says so, and this queue agrees. */
  bridge.request(createPayload(REQUEST_A))
  await settle()
  assert.deepEqual(ran, [REQUEST_A])
  assert.equal(queue.latch(), REQUEST_A)
  release()
  await settle()
  assert.deepEqual(bridge.completions.map(r => r.requestId), [REQUEST_A])
  assert.ok(!queue.latch())
})
