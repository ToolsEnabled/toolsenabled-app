/* The packaged smoke gate's capability half.
 *
 * These drive assertCapabilityRoundTrip() with a fake capability layer so every
 * refusal can be reached deterministically. The end-to-end proof that the same
 * function goes red on a real payload missing tools/secrets.ps1 and green on one
 * carrying it is not something a unit test can hold; it was measured against
 * release/win-unpacked and is recorded in the lane report. What these tests
 * protect is that each refusal still FIRES, and fires with its own message. */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import {
  APP_EXE,
  AUDIT_FAILURE_MARKER,
  AUDIT_TAIL_TOOL,
  CAPABILITY_DIRECTORY,
  MCP_ENTRYPOINT_BASENAME,
  PAYLOAD_RECORD,
  ROUND_TRIP_TOOL,
  assertCapabilityRoundTrip,
  runAll,
} from '../smoke-packaged.mjs'

const SIGNED_ROW = {
  action: 'mcp.tool.succeeded',
  target: ROUND_TRIP_TOOL,
  sequence: 1,
  keyId: 'audit-ed25519-1111111111111111111111111111111111111111111111111111111111111111',
}

async function packagedTree(t, { payload = {}, withPayloadRecord = true } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'smoke-capability-'))
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 10 }))
  await writeFile(path.join(directory, APP_EXE), 'not a real executable')
  const capability = path.join(directory, CAPABILITY_DIRECTORY)
  await mkdir(capability, { recursive: true })
  if (withPayloadRecord) {
    await writeFile(path.join(capability, PAYLOAD_RECORD), JSON.stringify({
      entrypoints: ['tools/mission-bridge.js', `src/${MCP_ENTRYPOINT_BASENAME}`],
      ...payload,
    }))
  }
  return directory
}

/* A fake capability layer: answers MCP requests from a scripted table and can
 * be told to write to stderr, so the "audit write failed but a row was
 * readable" case is reachable without a real vault. */
function fakeLayer({ replies, stderrText = '' } = {}) {
  const child = new EventEmitter()
  child.pid = 4242
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  child.exitCode = null
  child.signalCode = null
  child.kill = () => true

  child.stdin.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (!line.trim()) continue
      const message = JSON.parse(line)
      if (message.id === undefined) continue
      const reply = replies(message)
      if (reply === undefined) continue
      setImmediate(() => child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, ...reply })}\n`))
    }
  })
  if (stderrText) setImmediate(() => child.stderr.write(stderrText))
  return child
}

function toolText(value) {
  return { result: { content: [{ type: 'text', text: JSON.stringify(value) }] } }
}

function dependencies(child, overrides = {}) {
  return {
    spawn: () => child,
    copyPayload: async () => {},
    terminateProcessTree: async () => {},
    timeoutMs: 5_000,
    log: () => {},
    ...overrides,
  }
}

function scripted({ rows = [SIGNED_ROW], call = toolText({ ok: true }), tail } = {}) {
  return (message) => {
    if (message.method === 'initialize') return { result: { serverInfo: { name: 'fake' } } }
    if (message.method !== 'tools/call') return { result: {} }
    if (message.params.name === ROUND_TRIP_TOOL) return call
    if (message.params.name === AUDIT_TAIL_TOOL) return tail ?? toolText(rows)
    return { result: {} }
  }
}

test('K1 - a call that round-trips AND lands a signed audit row passes', async (t) => {
  const directory = await packagedTree(t)
  const child = fakeLayer({ replies: scripted() })
  const result = await assertCapabilityRoundTrip(directory, dependencies(child))
  assert.equal(result.tool, ROUND_TRIP_TOOL)
  assert.equal(result.sequence, 1, 'the passing result must carry the audit sequence it verified')
  assert.equal(result.keyId, SIGNED_ROW.keyId, 'the passing result must carry the key the row was signed with')
})

test('K2 - a successful call that lands NO audit row fails, which is the defect that shipped', async (t) => {
  const directory = await packagedTree(t)
  // Exactly the measured shape: the tool returns success, the ledger is empty.
  const child = fakeLayer({ replies: scripted({ rows: [] }) })
  await assert.rejects(
    assertCapabilityRoundTrip(directory, dependencies(child)),
    (error) => {
      assert.match(error.message, /LANDED NO AUDIT ROW/, 'the failure must name the missing row, not the tool call')
      return true
    },
    'a tool call that succeeds while the signed ledger records nothing must fail this gate',
  )
})

test('K3 - an audit row for some other tool does not count as this call being recorded', async (t) => {
  const directory = await packagedTree(t)
  const child = fakeLayer({ replies: scripted({ rows: [{ ...SIGNED_ROW, target: 'some.other_tool' }] }) })
  await assert.rejects(
    assertCapabilityRoundTrip(directory, dependencies(child)),
    /LANDED NO AUDIT ROW/,
    'the row must be matched to the tool that was called',
  )
})

test('K4 - an UNSIGNED audit row fails with its own message', async (t) => {
  const directory = await packagedTree(t)
  const child = fakeLayer({ replies: scripted({ rows: [{ ...SIGNED_ROW, keyId: '' }] }) })
  await assert.rejects(
    assertCapabilityRoundTrip(directory, dependencies(child)),
    (error) => {
      assert.match(error.message, /UNSIGNED/, 'an unsigned row must not be mistaken for a missing one')
      return true
    },
    'an unsigned ledger is not the tamper-evident record the product claims',
  )
})

test('K5 - a refused tool call fails before the ledger is ever consulted', async (t) => {
  const directory = await packagedTree(t)
  const child = fakeLayer({
    replies: scripted({ call: { result: { isError: true, content: [{ type: 'text', text: 'vault absent' }] } } }),
  })
  await assert.rejects(
    assertCapabilityRoundTrip(directory, dependencies(child)),
    (error) => {
      assert.match(error.message, /REFUSED on a fresh install/)
      assert.doesNotMatch(error.message, /LANDED NO AUDIT ROW/, 'a refused call must not be reported as an audit gap')
      return true
    },
    'a tool that cannot run at all must be reported as a refusal',
  )
})

test('K6 - an unreadable audit ledger fails distinctly from an empty one', async (t) => {
  const directory = await packagedTree(t)
  const child = fakeLayer({
    replies: scripted({ tail: { result: { isError: true, content: [{ type: 'text', text: 'internal error' }] } } }),
  })
  await assert.rejects(
    assertCapabilityRoundTrip(directory, dependencies(child)),
    (error) => {
      assert.match(error.message, /audit ledger could not be read/)
      assert.match(error.message, /privacy policy promises this ledger in writing/)
      return true
    },
    'a ledger that refuses to be read is a different failure from a ledger that recorded nothing',
  )
})

test('K7 - a canonical audit write failure on stderr fails even when a row is readable', async (t) => {
  const directory = await packagedTree(t)
  const child = fakeLayer({
    replies: scripted(),
    stderrText: `ToolsEnabled ${AUDIT_FAILURE_MARKER}: The audit signing key cannot be read.\n`,
  })
  await assert.rejects(
    assertCapabilityRoundTrip(directory, dependencies(child)),
    /canonical audit write failure/,
    'a layer reporting audit failures on stderr must not pass because one stale row happened to be readable',
  )
})

test('K8 - a payload with no capability directory fails before anything is spawned', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'smoke-capability-bare-'))
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 10 }))
  await writeFile(path.join(directory, APP_EXE), 'not a real executable')
  let spawned = false
  await assert.rejects(
    assertCapabilityRoundTrip(directory, dependencies(null, { spawn: () => { spawned = true } })),
    /ships no capability payload/,
    'a viewer-only build must fail this gate by name',
  )
  assert.equal(spawned, false, 'nothing may be spawned when there is no payload to spawn')
})

test('K9 - a payload declaring no MCP entrypoint fails rather than guessing one', async (t) => {
  const directory = await packagedTree(t, { payload: { entrypoints: ['tools/mission-bridge.js'] } })
  await assert.rejects(
    assertCapabilityRoundTrip(directory, dependencies(null, { spawn: () => { throw new Error('must not spawn') } })),
    /no payload entrypoint is named mcp-server\.js/,
    'the tool surface this gate exercises must be located by declaration, never assumed by index',
  )
})

test('K10 - the layer is spawned in Node mode with LOCALAPPDATA, USERPROFILE and CODEX_HOME redirected', async (t) => {
  const directory = await packagedTree(t)
  const child = fakeLayer({ replies: scripted() })
  let observed = null
  await assertCapabilityRoundTrip(directory, dependencies(child, {
    spawn: (executable, args, options) => { observed = { executable, args, options }; return child },
  }))

  assert.equal(observed.options.env.ELECTRON_RUN_AS_NODE, '1', 'without Node mode the packaged binary opens a window instead')
  for (const variable of ['LOCALAPPDATA', 'USERPROFILE', 'CODEX_HOME']) {
    const value = observed.options.env[variable]
    assert.ok(value, `${variable} must be set for the child`)
    assert.notEqual(value, process.env[variable], `${variable} must NOT be inherited: a builder's own state is exactly what a customer will not have`)
  }
  assert.equal(observed.options.env.APPVEYOR, undefined, 'the child environment is constructed, not inherited')
  assert.match(observed.args[0], /mcp-server\.js$/, 'the layer is started at its declared MCP entrypoint')
})

test('K10b - the layer is told the sterile state root it is asserted against', async (t) => {
  /* Since engine 81b14e15 a packaged payload given no TOOLSENABLED_STATE_ROOT
     anchors its state to the installing account's own profile (from the process
     token, not APPDATA), so a launch that says nothing writes into the builder's
     real per-user root -- measured on the 1.0.40 r10 cut. */
  const directory = await packagedTree(t)
  const child = fakeLayer({ replies: scripted() })
  let observed = null
  await assertCapabilityRoundTrip(directory, dependencies(child, {
    spawn: (executable, args, options) => { observed = { executable, args, options }; return child },
  }))
  const stateRoot = observed.options.env.TOOLSENABLED_STATE_ROOT
  assert.ok(stateRoot, 'TOOLSENABLED_STATE_ROOT must be stated for the child')
  assert.equal(
    stateRoot,
    path.join(observed.options.env.APPDATA, 'ToolsEnabled', 'capability'),
    'the stated root must sit under the sterile APPDATA the run asserts on',
  )
  assert.notEqual(stateRoot, process.env.TOOLSENABLED_STATE_ROOT, 'the root must NOT be inherited')

  const source = await readFile(new URL('../smoke-packaged.mjs', import.meta.url), 'utf8')
  assert.ok(
    source.includes("TOOLSENABLED_STATE_ROOT: path.join(profile.appData, 'ToolsEnabled', 'capability')"),
    'sterileEnvironment must state TOOLSENABLED_STATE_ROOT under the sterile profile appData',
  )
})

test('K11 - the payload is copied out of resources/capability rather than run in place', async (t) => {
  const directory = await packagedTree(t)
  const child = fakeLayer({ replies: scripted() })
  let copied = null
  await assertCapabilityRoundTrip(directory, dependencies(child, {
    copyPayload: async (from, to) => { copied = { from, to } },
  }))
  assert.equal(
    copied.from,
    path.join(directory, CAPABILITY_DIRECTORY),
    'the bytes exercised must be the shipped ones',
  )
  assert.notEqual(
    path.resolve(copied.to),
    path.resolve(path.join(directory, CAPABILITY_DIRECTORY)),
    'running in place would leave state/ inside a payload that config/payload-boundary.json declares state-free',
  )
})

test('K12 - the sterile profile is removed even when the round-trip fails', async (t) => {
  const directory = await packagedTree(t)
  const child = fakeLayer({ replies: scripted({ rows: [] }) })
  let removed = null
  await assert.rejects(assertCapabilityRoundTrip(directory, dependencies(child, {
    removeSmokeProfileDirectory: async (value) => { removed = value },
  })))
  assert.ok(removed, 'a failing gate must not leak its temporary profile')
})

test('K13 - runAll runs the window check AND the capability round-trip, in that order', async () => {
  const order = []
  const result = await runAll('anywhere', {
    main: async () => { order.push('window'); return { port: 4601 } },
    assertCapabilityRoundTrip: async () => { order.push('capability'); return { tool: ROUND_TRIP_TOOL } },
  })
  assert.deepEqual(order, ['window', 'capability'], 'a window that never appears makes the capability question unreadable')
  assert.equal(result.window.port, 4601)
  assert.equal(result.capability.tool, ROUND_TRIP_TOOL)
})

test('K14 - runAll fails when the capability round-trip fails, even with a healthy window', async () => {
  await assert.rejects(
    runAll('anywhere', {
      main: async () => ({ port: 4601 }),
      assertCapabilityRoundTrip: async () => { throw new Error('LANDED NO AUDIT ROW') },
    }),
    /LANDED NO AUDIT ROW/,
    'a bound port and a title must no longer be sufficient for this gate to pass',
  )
})
