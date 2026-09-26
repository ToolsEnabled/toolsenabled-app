/* THE MAIN THREAD MUST COME BACK BETWEEN THE ASKING AND THE ANSWERING.
 *
 * Every mc-* ipcMain.handle body in shell/main.cjs runs on Electron's main
 * thread, and so does the shell's own HTTP server. The per-call filesystem
 * work those handlers do used to be synchronous, so every session on the
 * machine stopped for the duration of somebody else's save.
 *
 * These tests drive shell/durable-file.cjs -- the module those handlers now
 * delegate to -- with real files in a real directory, and assert what a caller
 * can observe: that the answer arrives only after the loop has been handed
 * back, that it is the SAME answer the synchronous version gives for every
 * outcome, and that the queue puts back the call ordering the synchronous code
 * used to give away for free.
 *
 * The first two tests are the gate the lane asks for: if a synchronous read or
 * write returns to the worst offender -- the durable fleet-profile record --
 * the answer arrives without a single turn of the loop and they go red.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const require_ = createRequire(import.meta.url)
const durableFile = require_('../../shell/durable-file.cjs')

async function scratch() {
  return mkdtemp(path.join(os.tmpdir(), 'ipc-sync-io-'))
}

/* How many turns of the loop happened between issuing the call and its answer.
 *
 * A truly awaited syscall gives the loop back, so the pump below runs at least
 * once while it is outstanding. A synchronous read wrapped in a promise
 * resolves on the microtask queue instead, which drains BEFORE any timer or
 * immediate, and this counts zero. That difference is the whole point of the
 * change, and it is a property of the call, not of how it is spelled. */
async function turnsWhileWaiting(run) {
  let turns = 0
  let pumping = true
  const pump = () => {
    if (!pumping) return
    turns += 1
    setImmediate(pump)
  }
  setImmediate(pump)
  const value = await run()
  pumping = false
  return { turns, value }
}

test('the durable record read hands the main thread back before it answers', async (t) => {
  const directory = await scratch()
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'fleet-profile.json')
  await writeFile(file, `${JSON.stringify({ storageVersion: 1, state: 'configured' })}\n`, 'utf8')

  const { turns, value } = await turnsWhileWaiting(() => durableFile.readBoundedFile(file, 2 * 1024 * 1024))

  assert.equal(value.state, durableFile.PRESENT, 'the read must still return the record it was asked for')
  assert.ok(turns > 0,
    `reading the durable record must give the loop back at least once; it answered after ${turns} turns, `
    + 'which is what a synchronous read inside a promise looks like from here')
})

test('the durable record write hands the main thread back before it answers', async (t) => {
  const directory = await scratch()
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'fleet-profile.json')

  const { turns } = await turnsWhileWaiting(() =>
    durableFile.replaceFileDurably(file, `${JSON.stringify({ storageVersion: 1, state: 'reset' })}\n`))

  assert.equal(JSON.parse(await readFile(file, 'utf8')).state, 'reset', 'the write must still have landed')
  assert.ok(turns > 0,
    `saving the durable record must give the loop back at least once; it answered after ${turns} turns`)
})

test('the accounts usage cache read hands the main thread back before it answers', async (t) => {
  const directory = await scratch()
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'accounts-usage-cache.json')
  await writeFile(file, `${JSON.stringify({ ok: true, readAt: new Date().toISOString(), accounts: [] }, null, 2)}\n`, 'utf8')

  const { turns, value } = await turnsWhileWaiting(() => durableFile.readBoundedFile(file))

  assert.equal(value.state, durableFile.PRESENT, 'the cache read must still return the cache')
  assert.ok(turns > 0, `reading the usage cache must give the loop back at least once; it answered after ${turns} turns`)
})

test('the awaited read answers exactly what the synchronous read answers, outcome for outcome', async (t) => {
  const directory = await scratch()
  t.after(() => rm(directory, { recursive: true, force: true }))
  const limit = 64

  const present = path.join(directory, 'present.json')
  await writeFile(present, '{"storageVersion":1}', 'utf8')
  const missing = path.join(directory, 'missing.json')
  const oversized = path.join(directory, 'oversized.json')
  await writeFile(oversized, 'x'.repeat(limit + 1), 'utf8')
  const folder = path.join(directory, 'a-folder.json')
  await mkdir(folder)

  for (const [name, file] of [['a record that is there', present], ['a record that is not', missing],
    ['a record past its limit', oversized], ['a directory in its place', folder]]) {
    const awaited = await durableFile.readBoundedFile(file, limit)
    const immediate = durableFile.readBoundedFileSync(file, limit)
    assert.deepEqual(awaited, immediate, `${name} must read the same either way`)
  }

  assert.equal((await durableFile.readBoundedFile(missing, limit)).state, durableFile.ABSENT,
    'a missing record is absent, not a failure -- the fleet profile treats those differently')
  assert.equal((await durableFile.readBoundedFile(oversized, limit)).state, durableFile.TOO_LARGE,
    'a record past its limit must be refused by size rather than read')
  assert.equal((await durableFile.readBoundedFile(folder, limit)).state, durableFile.NOT_FILE,
    'a directory standing where the record belongs must be named as such')
})

test('a durable write replaces the whole file and leaves no temporary behind', async (t) => {
  const directory = await scratch()
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'nested', 'fleet-profile.json')

  await durableFile.replaceFileDurably(file, 'first\n', { tempPrefix: '.fleet-profile' })
  await durableFile.replaceFileDurably(file, 'second\n', { tempPrefix: '.fleet-profile' })

  assert.equal(await readFile(file, 'utf8'), 'second\n', 'the second write must replace the first entirely')
  const leftovers = (await readdir(path.dirname(file))).filter(name => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [], 'a finished write must leave no temporary file beside the record')
})

test('the last write asked for is the last write applied, however long the earlier one takes', async (t) => {
  const directory = await scratch()
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'fleet-profile.json')
  const order = durableFile.serialQueue()

  /* The defect this queue exists to prevent, in miniature: a big save and a
     small erase issued back to back. Ungated, each builds its own temporary
     file and they race to rename -- the slow one lands last and puts back the
     record the fast one had just replaced. A person who saved a large fleet
     and then erased it would find it erased and, a moment later, back. */
  const bulky = `${JSON.stringify({ storageVersion: 1, state: 'configured', profile: { pad: 'x'.repeat(512 * 1024) } })}\n`
  const erased = `${JSON.stringify({ storageVersion: 1, state: 'reset' })}\n`

  const save = order(() => durableFile.replaceFileDurably(file, bulky))
  const reset = order(() => durableFile.replaceFileDurably(file, erased))
  await Promise.all([save, reset])

  assert.equal(JSON.parse(await readFile(file, 'utf8')).state, 'reset',
    'the erase was asked for second, so it must be what the record says')
})

test('a read queued after a write sees that write', async (t) => {
  const directory = await scratch()
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'accounts-usage-cache.json')
  const order = durableFile.serialQueue()

  const seen = []
  for (let generation = 0; generation < 6; generation += 1) {
    void order(() => durableFile.replaceFileAtomically(file, `${JSON.stringify({ generation })}\n`))
    void order(async () => {
      const read = await durableFile.readBoundedFile(file)
      seen.push(JSON.parse(read.text).generation)
    })
  }
  await order(async () => undefined)

  assert.deepEqual(seen, [0, 1, 2, 3, 4, 5],
    'each read must answer with the write that was asked for just before it, not an older one')
})

test('one failed operation is delivered to its own caller and does not wedge the queue', async (t) => {
  const directory = await scratch()
  t.after(() => rm(directory, { recursive: true, force: true }))
  const order = durableFile.serialQueue()

  const failure = order(async () => { throw Object.assign(new Error('disk is full'), { code: 'ENOSPC' }) })
  /* Observed here only so the runner does not warn about a rejection that is
     handled a few lines further down; assert.rejects still does the asserting. */
  void failure.then(() => {}, () => {})
  const after = order(async () => 'still running')

  await assert.rejects(failure, /disk is full/, 'the caller that failed must be the caller that hears about it')
  assert.equal(await after, 'still running', 'a later caller must not inherit an earlier failure')
})

/* MEASURED 2026-09-03 on Windows 10, node v22.14.0: an ungated read of the
 * cache during its replacement did not merely see an older copy -- it made the
 * replacement FAIL, with
 *   EPERM: operation not permitted, rename 'accounts-usage-cache.json.tmp-8672'
 *     -> 'accounts-usage-cache.json'
 * because Windows refuses to rename over a path another handle has open. The
 * synchronous code could never hit that: it held the thread, so a read and a
 * rename could not overlap. Sharing one queue is therefore not a tidiness
 * choice on this platform -- it is what keeps an allowance read from throwing
 * away the write that was meant to record it. */
test('a read arriving during a replacement neither tears nor breaks the write', async (t) => {
  const directory = await scratch()
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'accounts-usage-cache.json')
  const text = `${JSON.stringify({ ok: true, readAt: new Date().toISOString(), accounts: [{ name: 'one' }] }, null, 2)}\n`
  const order = durableFile.serialQueue()

  await order(() => durableFile.replaceFileAtomically(file, 'old\n'))
  const replacing = order(() => durableFile.replaceFileAtomically(file, text))
  const during = order(() => durableFile.readBoundedFile(file))
  await assert.doesNotReject(replacing,
    'a read issued mid-replacement must not be able to make the replacement fail')
  const read = await during

  assert.ok(read.text === 'old\n' || read.text === text,
    'a read landing around a replacement must see one whole version or the other, never a fragment')
  assert.equal(await readFile(file, 'utf8'), text, 'the replacement must be what the file ends up holding')
})
