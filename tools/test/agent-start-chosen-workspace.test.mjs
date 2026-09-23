/* THE FOLDER A PERSON PICKS IN SETUP IS THE FOLDER THE AGENT WORKS IN.
 *
 * Measured on the 2026-08-18 fresh-install walkthrough: setup created and
 * git-initialised the chosen folder (Documents\AI Workspace), and the agent
 * then ran in <userData>\workspace — shell/main.cjs's WORKSPACE_ROOT — while
 * the audit recorded cwd:null. The fence was real but anchored on a folder
 * nobody chose, and the promised undo history sat on a folder nothing used.
 *
 * The rule under test: an agent start that names no folder itself (no session
 * profile, no renderer cwd) runs in the workspace setup recorded — the one the
 * person was asked about and answered (`workspaceChosen`) — and only a machine
 * where nobody was ever asked falls back to <userData>\workspace. The audit
 * record carries the real folder because the default is resolved BEFORE the
 * spawn record is written.
 *
 * main.cjs is an Electron entry and cannot be imported here, so the handler's
 * ordering is pinned against its source and the resolver is lifted out and
 * driven as a function — the same two devices tools/test/palette-rows.test.mjs
 * uses on the view's closure.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const MAIN = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')

function resolverSource() {
  const at = MAIN.indexOf('function chosenWorkspaceCwd')
  assert.ok(at >= 0, 'shell/main.cjs has no chosenWorkspaceCwd — unaddressed starts still land in <userData>\\workspace')
  const end = MAIN.indexOf('\n}', at)
  assert.ok(end > at)
  return MAIN.slice(at, end + 2)
}

function makeResolver({ state, mkdirs = [] }) {
  const factory = new Function(
    'readWorkspaceState',
    'fs',
    `${resolverSource()}; return chosenWorkspaceCwd;`,
  )
  return factory(
    typeof state === 'function' ? state : () => state,
    { mkdirSync: (dir) => { mkdirs.push(dir) } },
  )
}

test('an unaddressed start is anchored on the chosen workspace BEFORE the spawn record is written', () => {
  const at = MAIN.indexOf("ipcMain.handle('mc-agent:start'")
  assert.ok(at >= 0)
  assert.match(MAIN.slice(at, MAIN.indexOf('\n})', at)), /run\('agent:start'/, 'the start channel no longer dispatches to the shared surface')
  /* Re-pointed at shell/agent-command-surface.cjs after the command-surface
     extraction moved the start body there (chosenWorkspaceCwd() itself stays
     in main.cjs and is handed in as a dependency); the ordering fact is unchanged. */
  const SURFACE = readFileSync(new URL('../../shell/agent-command-surface.cjs', import.meta.url), 'utf8')
  const bodyAt = SURFACE.indexOf("'agent:start': async")
  assert.ok(bodyAt >= 0, 'the surface has no start body')
  const bodyEnd = SURFACE.indexOf("'agent:send': async", bodyAt)
  const handler = SURFACE.slice(bodyAt, bodyEnd > bodyAt ? bodyEnd : bodyAt + 6000)
  /* Call sites, not mentions — the comments beside both calls name the other
     one, so a bare-name search reads the explanation as the code. */
  const resolvedAt = handler.indexOf('chosenWorkspaceCwd()')
  const recordedAt = handler.indexOf('recordSpawnIntent(request)')
  assert.ok(resolvedAt >= 0, 'the start handler never consults the chosen workspace')
  assert.ok(recordedAt >= 0, 'the start handler no longer records the spawn — this suite needs re-reading')
  assert.ok(resolvedAt < recordedAt,
    'the chosen folder is resolved after the record is written, so the audit still says cwd:null')
})

test('the chosen folder is the answer, and it is prepared so a deleted folder self-heals', () => {
  const mkdirs = []
  const resolve = makeResolver({
    state: { ok: true, available: true, configured: true, chosen: true, roots: ['C:\\People\\Documents\\AI Workspace'] },
    mkdirs,
  })
  assert.equal(resolve(), 'C:\\People\\Documents\\AI Workspace')
  assert.deepEqual(mkdirs, ['C:\\People\\Documents\\AI Workspace'],
    'the chosen folder is not re-created, so deleting it strands every future start')
})

test('a folder nobody was ever asked about is NOT the answer — the fallback stays the fallback', () => {
  /* recordTier picks a default folder silently before the workspace question is
     shown; `chosen` is the flag that a person answered. A default nobody saw
     must not become the fence anchor. */
  const unasked = makeResolver({
    state: { ok: true, available: true, configured: true, chosen: false, roots: ['C:\\People\\Documents\\AI Workspace'] },
  })
  assert.equal(unasked(), null)
})

test('every damaged or empty record answers null rather than a guess', () => {
  assert.equal(makeResolver({ state: { ok: true, available: false, roots: [] } })(), null)
  assert.equal(makeResolver({ state: { ok: true, available: true, configured: false, chosen: false, roots: [] } })(), null)
  assert.equal(makeResolver({ state: { ok: true, available: true, configured: true, chosen: true, roots: [] } })(), null)
  assert.equal(makeResolver({ state: () => { throw new Error('unreadable') } })(), null)
})
