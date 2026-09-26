/* The IPC channel that carries the app's own agent record to the home screen.
 *
 * Separate from tools/test/agent-history-read.test.mjs, which tests the
 * recorder, because the two land in different commits: the recorder's read
 * function is self-contained, while these two shell files were carrying two
 * other lanes' in-flight work when the recorder was committed, and sweeping
 * that into someone else's commit is not a thing this repo does.
 *
 * What is asserted here is the part that is easy to lose in a merge: the
 * channel exists on the preload the application actually loads (shell/
 * preload.cjs is reachable from no window -- a bridge added there is a green
 * test over a dead feature, which is precisely the defect that removed an
 * earlier version of the agent bridge), and it carries the same sender check
 * as every other agent channel. A record of what has run on someone's computer
 * is not readable by any frame that happens to be loaded.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { createAgentCommandSurface, REQUIRED_DEPS } = require('../../shell/agent-command-surface.cjs')

function historySurface(spawnRecordHistory) {
  const deps = {}
  for (const [name, kind] of Object.entries(REQUIRED_DEPS)) {
    deps[name] = kind === 'function' ? () => undefined
      : kind === 'number' ? 1
        : kind === 'string' ? 'workspace'
          : {}
  }
  Object.assign(deps, {
    agentSessions: new Map(),
    dialog: { showOpenDialog: () => undefined },
    AGENT_EFFORT_VALUES: [],
    agentPayload: value => value,
    spawnRecordHistory,
  })
  return createAgentCommandSurface(deps)
}

/* WHERE THE BODIES LIVE NOW. The mc-agent:* handlers in shell/main.cjs became
   thin wrappers when their bodies were extracted to
   shell/agent-command-surface.cjs (the shared surface the relay facade design
   names, so IPC and web cannot drift). The frame check is still main.cjs's
   fact; the parse, the record and the spawn are the surface's. The pins below
   were re-pointed accordingly -- same facts, new home. */
const SURFACE = readFileSync(new URL('../../shell/agent-command-surface.cjs', import.meta.url), 'utf8')
function surfaceBody(command) {
  const start = SURFACE.indexOf(`'${command}': async`)
  assert.ok(start >= 0, `the surface has no body for ${command}`)
  const next = SURFACE.slice(start + 1).search(/\n    '(agent|org):[a-z-]+': async/)
  return next === -1 ? SURFACE.slice(start) : SURFACE.slice(start, start + 1 + next)
}

test('the read channel is exposed on the preload the application actually loads', () => {
  const preload = readFileSync(new URL('../../shell/fleet-profile-preload.cjs', import.meta.url), 'utf8')
  assert.match(
    preload, /history: request => ipcRenderer\.invoke\('mc-agent:history'/,
    'the bridge the home screen calls exists on the loaded preload',
  )
  const exposure = preload.slice(preload.indexOf("exposeInMainWorld('mcAgent'"))
  assert.ok(exposure.indexOf('history:') < exposure.indexOf('}))'), 'and it is on the mcAgent bridge, not some other one')
})

test('the read channel carries the same sender check as every other agent channel', () => {
  const main = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
  const start = main.indexOf("ipcMain.handle('mc-agent:history'")
  assert.ok(start >= 0, 'the channel is handled in the main process')
  const body = main.slice(start, main.indexOf('\n})', start))
  assert.match(
    body, /assertTrustedAgentSender\(event\)/,
    'a record of what ran on this machine is not readable by any frame that happens to be loaded',
  )
  assert.match(body, /run\('agent:history'/, 'and the wrapper dispatches to the shared surface by its own name')
  /* Re-pointed at the surface body after the command-surface extraction; the facts are unchanged. */
  const surfaceBodyText = surfaceBody('agent:history')
  assert.match(surfaceBodyText, /agentPayload\(/, 'and the request shape is validated like every other agent channel')
  assert.match(surfaceBodyText, /spawnRecordHistory\(/, 'and it answers from the recorder rather than reading the file itself')
})

test('the history command returns the recorder history for the requested limit', async () => {
  const expected = [{ id: 'record-from-recorder' }]
  const calls = []
  const surface = historySurface(limit => {
    calls.push(limit)
    return expected
  })

  const result = await surface.run(
    'agent:history',
    { limit: 7 },
    { kind: 'window', owner: {}, mayWrite: true, label: 'window' },
  )

  assert.deepEqual(calls, [7], 'history must ask the recorder for the requested number of records')
  assert.strictEqual(result, expected, 'history must return the recorder result rather than a substitute')
})

/* THE ONE ABSOLUTE CLAIM THE HOME SCREEN MAKES, PINNED TO THE CODE THAT MAKES
 * IT TRUE.
 *
 * Home prints "ToolsEnabled writes each one down on this computer before it
 * starts", and in its footer "Written down on this computer as it happened".
 * Every other sentence on that screen is derived from state and recomputed, so
 * it cannot go stale. These two are different in kind: they are standing claims
 * about the ORDERING of two statements in shell/main.cjs, a file the home lane
 * does not own, and they would go quietly false if a refactor moved the spawn
 * ahead of the record. Nothing on the screen would change.
 *
 * The first-run lane derived this rule from an incident in its own file -- a
 * sentence about credentials that went false twice in one session because the
 * lane that falsified it never read it. An absolute claim needs a written
 * reason it is still true, held where the claim can be broken rather than where
 * it is printed. This is that reason for these two sentences.
 *
 * The behavioural half already exists (tools/test/spawn-record.test.mjs: no
 * keystore means no receipt, and therefore no spawn). This is the ordering
 * half, which no behavioural test can see, because a recorder that writes
 * AFTER a successful spawn passes every one of them. */
test('a session is recorded BEFORE it is spawned, which is what home tells the reader', () => {
  const main = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
  const start = main.indexOf("ipcMain.handle('mc-agent:start'")
  assert.ok(start >= 0, 'the start channel is handled in the main process')
  assert.match(main.slice(start, main.indexOf('\n})', start)), /run\('agent:start'/, 'and it dispatches to the shared surface')
  /* Re-pointed at the surface body after the command-surface extraction: the ordering claim is the same, its home moved. */
  const body = surfaceBody('agent:start')

  const recordedAt = body.indexOf('recordSpawnIntent(')
  const spawnedAt = body.indexOf('startSession(')
  assert.ok(recordedAt >= 0, 'the start path records a spawn intent')
  assert.ok(spawnedAt >= 0, 'and the start path spawns')
  assert.ok(
    recordedAt < spawnedAt,
    'the record is written first. Home says "before it starts"; if this ordering flips, that sentence is false '
    + 'and nothing else in the product would show it.',
  )
  /* And there is only one spawn in this handler, so "the first one is after the
     record" cannot be true while a second one runs before it. */
  assert.equal(
    (body.match(/startSession\(/g) || []).length, 1,
    'exactly one spawn, so the ordering above covers the whole path',
  )
})

test('the channel starts nothing', () => {
  const main = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
  const start = main.indexOf("ipcMain.handle('mc-agent:history'")
  /* Guarded like every other anchor in this file, because it is not: on a miss
     indexOf returns -1, slice(-1, <small>) is the EMPTY STRING, and all five
     doesNotMatch assertions below pass against "". Renaming or removing the
     channel would leave this reading as a green guard over a channel that is
     no longer there -- the failure that never gets removed, because nothing
     can see it. */
  assert.ok(start >= 0, 'the channel is handled in the main process')
  const body = main.slice(start, main.indexOf('\n})', start))
  /* Both homes after the command-surface extraction: the wrapper in main.cjs AND the body in the surface. */
  for (const text of [body, surfaceBody('agent:history')]) {
    for (const forbidden of [/startSession/, /sendTurn/, /getAgentHost/, /recordSpawnIntent/, /\.record\(/]) {
      assert.doesNotMatch(text, forbidden, 'a read channel must not be able to create or record anything')
    }
  }
})
