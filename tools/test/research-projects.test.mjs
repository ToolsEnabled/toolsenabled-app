import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PROJECT_ALL,
  PROJECT_UNFILED,
  filesUnder,
  readProjectSelection,
  readResearchSnapshot,
  saveProject,
  writeProjectSelection,
} from '../../src/research-projects.js'

/* The project layer: the bridge envelope survives every failure, and the
   selection is a local remembering, never data. */

function memoryStorage() {
  const map = new Map()
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: key => { map.delete(key) },
  }
}

test('a bridge refusal comes back verbatim, never as an empty project list', async () => {
  const refusal = { ok: false, reason: 'action bridge unreachable', code: 'BRIDGE_UNREACHABLE' }
  const result = await readResearchSnapshot({ snapshot: async () => refusal })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'action bridge unreachable')
  assert.equal(result.code, 'BRIDGE_UNREACHABLE')
})

test('a shaped snapshot unpacks; a malformed one is named, not guessed at', async () => {
  const good = await readResearchSnapshot({
    snapshot: async () => ({
      ok: true,
      receipt: {
        projects: [{ projectId: 'rp-1234', name: 'Demo', enabled: true }],
        experiments: { 'rp-1234': [] },
        assignments: [],
        settings: { pipelineEnabled: false, runnerKinds: {} },
        lifecycle: { status: 'stopped', running: false },
      },
    }),
  })
  assert.equal(good.ok, true)
  assert.equal(good.projects[0].name, 'Demo')
  assert.equal(good.settings.pipelineEnabled, false)

  const malformed = await readResearchSnapshot({ snapshot: async () => ({ ok: true, receipt: { projects: 'nope' } }) })
  assert.equal(malformed.ok, false)
  assert.equal(malformed.code, 'RESEARCH_SNAPSHOT_INVALID')
})

test('saveProject returns the durable project or a named refusal', async () => {
  const saved = await saveProject({ name: 'Demo' }, {
    postAction: async (action, body) => {
      assert.equal(action, 'research-project-save')
      assert.equal(body.name, 'Demo')
      return { ok: true, receipt: { project: { projectId: 'rp-abcd', name: 'Demo' } } }
    },
  })
  assert.equal(saved.ok, true)
  assert.equal(saved.project.projectId, 'rp-abcd')

  const refused = await saveProject({ name: 'Demo' }, { postAction: async () => ({ ok: false, reason: 'the research pipeline is off', code: 'RESEARCH_PIPELINE_DISABLED' }) })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'RESEARCH_PIPELINE_DISABLED')

  const hollow = await saveProject({ name: 'Demo' }, { postAction: async () => ({ ok: true, receipt: {} }) })
  assert.equal(hollow.ok, false)
  assert.equal(hollow.code, 'RESEARCH_PROJECT_RECEIPT_INVALID')
})

test('the selection remembers a project id and falls back to all on anything else', () => {
  const storage = memoryStorage()
  assert.equal(readProjectSelection(storage), PROJECT_ALL, 'absence is the all face')
  writeProjectSelection(storage, 'rp-1234abcd')
  assert.equal(readProjectSelection(storage), 'rp-1234abcd')
  writeProjectSelection(storage, PROJECT_UNFILED)
  assert.equal(readProjectSelection(storage), PROJECT_UNFILED)
  storage.setItem('mc.research.project', 'not-a-project-id')
  assert.equal(readProjectSelection(storage), PROJECT_ALL, 'a damaged selection resets rather than filtering by garbage')
  writeProjectSelection(storage, PROJECT_ALL)
  assert.equal(storage.getItem('mc.research.project'), null, 'the default face stores nothing')
})

test('a storage read failure is unavailable, not an absent selection, and is retried', () => {
  let reads = 0
  const storage = {
    getItem() {
      reads += 1
      if (reads === 1) {
        const busy = new Error('file table is busy')
        busy.code = 'EMFILE'
        throw busy
      }
      return 'rp-1234abcd'
    },
  }

  assert.throws(
    () => readProjectSelection(storage),
    error => error.code === 'RESEARCH_PROJECT_SELECTION_UNAVAILABLE'
      && /not a claim that no selection exists/.test(error.message)
      && error.cause?.code === 'EMFILE',
  )
  assert.equal(readProjectSelection(storage), 'rp-1234abcd', 'a could-not-read result is not cached or latched')
  assert.equal(reads, 2, 'the transient failure does not prevent a fresh storage read')

  const absent = memoryStorage()
  assert.equal(readProjectSelection(absent), PROJECT_ALL, 'control: a successful absent read still selects all')
  assert.equal(readProjectSelection(absent), PROJECT_ALL, 'control: repeated successful absence keeps its established answer')
})

test('filesUnder scopes all, unfiled and a specific project', () => {
  assert.equal(filesUnder(PROJECT_ALL, 'rp-1'), true)
  assert.equal(filesUnder(PROJECT_ALL, null), true)
  assert.equal(filesUnder(PROJECT_UNFILED, null), true)
  assert.equal(filesUnder(PROJECT_UNFILED, 'rp-1'), false)
  assert.equal(filesUnder('rp-1', 'rp-1'), true)
  assert.equal(filesUnder('rp-1', 'rp-2'), false)
})
