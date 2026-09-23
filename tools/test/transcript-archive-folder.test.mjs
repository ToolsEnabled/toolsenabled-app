/*
 * T1488: on Linux the Transcript archive folder accepted any absolute path. A
 * file, a folder that cannot be created and '/' all answered 'Settings saved.',
 * and closed conversations would have been archived there.
 *
 * This drives the main process's own transcript store (configure()) over a
 * temporary folder, as the Settings Save reaches it through mcTranscripts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const { createNodeTranscriptStore } = createRequire(import.meta.url)('../../shell/node-transcript-store.cjs')

function workspace(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-folder-'))
  t.after(() => {
    for (const locked of [path.join(directory, 'locked')]) { try { fs.chmodSync(locked, 0o700) } catch {} }
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const saved = []
  const store = createNodeTranscriptStore({ directory, saveSettings: async value => { saved.push(value) } })
  return { directory, store, saved }
}

test('a file, the top of the drive, or a folder that cannot be written is refused and not saved', async t => {
  const { directory, store, saved } = workspace(t)
  const file = path.join(directory, 'hostname')
  fs.writeFileSync(file, 'not a folder')
  await assert.rejects(store.configure({ archiveDirectory: file }), /is a file, not a folder/)
  await assert.rejects(store.configure({ archiveDirectory: path.parse(directory).root }), /not the top of the drive/)
  await assert.rejects(store.configure({ archiveDirectory: path.join(file, 'inside') }), /cannot be created or written/)
  if (process.getuid?.() !== 0) {
    const locked = path.join(directory, 'locked')
    fs.mkdirSync(locked, { mode: 0o500 })
    await assert.rejects(store.configure({ archiveDirectory: path.join(locked, 'archive') }), /cannot be created or written/)
    await assert.rejects(store.configure({ archiveDirectory: locked }), /cannot be created or written/)
  }
  assert.deepEqual(saved, [], 'a refused folder was saved')
})

test('a writable folder, existing or new, still saves and leaves no probe behind', async t => {
  const { directory, store, saved } = workspace(t)
  const fresh = path.join(directory, 'closed', 'archive')
  const answer = await store.configure({ archiveDirectory: fresh })
  assert.equal(answer.ok, true)
  assert.equal(saved.at(-1).archiveDirectory, fresh)
  assert.ok(fs.statSync(fresh).isDirectory(), 'a new folder is created')
  assert.deepEqual(fs.readdirSync(fresh), [], 'the write check left a file behind')
  // Changing another setting does not re-check (or write into) the folder.
  const again = await store.configure({ deleteNodesOnExit: true })
  assert.equal(again.ok, true)
  assert.equal(saved.at(-1).deleteNodesOnExit, true)
})
