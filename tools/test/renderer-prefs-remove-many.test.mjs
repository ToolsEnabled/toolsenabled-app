// Bulk removal keeps migration to one durable settings write. These tests use
// synthetic records and injected failures, not current live-corpus measurements.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const { MAX_RECORD_BYTES, RECORD_FILE, createRendererPrefs } = require_('../../shell/renderer-prefs.cjs')

function freshStore() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'te-prefs-removemany-'))
  return {
    directory,
    prefs: createRendererPrefs({ directory, fs, path, randomUUID }),
    file: path.join(directory, RECORD_FILE),
  }
}
const discard = dir => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) } catch { /* best effort */ } }
const valuesOn = file => JSON.parse(fs.readFileSync(file, 'utf8')).values

test('removeMany drops every named key and keeps everything else', () => {
  const { directory, prefs, file } = freshStore()
  try {
    prefs.set('mc.theme', 'black')
    prefs.set('a', '1')
    prefs.set('b', '2')

    const answer = prefs.removeMany(['a', 'b'])

    assert.equal(answer.ok, true)
    const values = valuesOn(file)
    assert.equal(Object.hasOwn(values, 'mc.theme'), true, 'a removal must not take anything it was not asked for')
    assert.equal(Object.hasOwn(values, 'a'), false)
    assert.equal(Object.hasOwn(values, 'b'), false)
  } finally { discard(directory) }
})

test('removeMany costs ONE durable write, however many keys it drops', () => {
  /* The whole reason it exists. Counted by watching the store's own write path
     rather than by reading the implementation: a fs whose writes are counted. */
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'te-prefs-writecount-'))
  try {
    let writes = 0
    const counting = Object.assign(Object.create(fs), {
      writeFileSync: (...args) => { writes += 1; return fs.writeFileSync(...args) },
    })
    const prefs = createRendererPrefs({ directory, fs: counting, path, randomUUID })
    for (let index = 0; index < 10; index += 1) prefs.set(`k${index}`, 'v')

    const before = writes
    prefs.removeMany(Array.from({ length: 10 }, (_, index) => `k${index}`))

    assert.equal(writes - before, 1,
      `ten keys must cost one write, not ten; saw ${writes - before}`)
  } finally { discard(directory) }
})

test('removing keys that are not there is not an error and writes nothing', () => {
  const { directory, prefs } = freshStore()
  try {
    prefs.set('mc.theme', 'black')
    const answer = prefs.removeMany(['nothing', 'here'])
    assert.equal(answer.ok, true)
    assert.equal(answer.unchanged, true, 'a no-op must not spend a durable write on the main thread')
  } finally { discard(directory) }
})

test('an empty list is a no-op, not a rewrite', () => {
  const { directory, prefs } = freshStore()
  try {
    prefs.set('mc.theme', 'black')
    assert.equal(prefs.removeMany([]).unchanged, true)
  } finally { discard(directory) }
})

/* ---------- the rescue property ---------- */

test('REMOVEMANY WORKS FROM INSIDE THE FAILURE, where the refusal is selective by size', () => {
  /* THE REACHABLE STATE, and writing this test corrected my own description of
     it. The record does not go OVER the ceiling and then start refusing: persist()
     bounds the record it is ABOUT TO WRITE, so the write that would cross the
     line is the one that is refused. The file therefore sits just UNDER the
     ceiling for ever, and every further ordinary write fails. (That is why the
     historical held-branch report cited 1,045,232 against 1,048,576, below
     it.) The remedy has to work from inside that state, or it is not a remedy. */
  const { directory, prefs, file } = freshStore()
  try {
    const big = 'x'.repeat(60_000)
    const keys = []
    let refusedAt = -1
    for (let index = 0; index < 20; index += 1) {
      const key = `mc.agent-recovery.v1:c:node-${index}`
      const answer = prefs.set(key, big)
      if (answer.ok) { keys.push(key); continue }
      assert.equal(answer.error.code, 'MC_PREFS_TOO_LARGE')
      refusedAt = index
      break
    }
    assert.ok(refusedAt > 0, 'the fixture must actually reach the ceiling and be refused')

    /* THE FAILURE IS SELECTIVE BY SIZE, AND THAT IS WORSE THAN A CLEAN STOP.
       Writing this case corrected my own account of the defect. persist() bounds
       the RESULTING record, so at the ceiling a write is refused only if it grows
       the record past the line. A big write is refused; a small update to a key
       that already exists barely changes the total and still succeeds. So the
       person's theme keeps saving while anything that needs real room -- notably
       the next ~43 KB agent-recovery record -- silently does not. A defect that
       fails everything is noticed immediately; one that fails only the large
       writes looks like the product working. */
    const small = prefs.set('mc.theme', 'black')
    assert.equal(small.ok, true, 'a small write still fits in the remaining headroom')

    const another = prefs.set('mc.agent-recovery.v1:c:one-more', 'x'.repeat(43_000))
    assert.equal(another.ok, false, 'the next recovery-sized record is what actually gets refused')
    assert.equal(another.error.code, 'MC_PREFS_TOO_LARGE')

    const held = Buffer.byteLength(JSON.stringify({ values: valuesOn(file) }), 'utf8')
    assert.ok(held <= MAX_RECORD_BYTES, `the record sits under the ceiling, not over it: ${held}`)

    /* And the removal succeeds, because it makes the record smaller. */
    assert.equal(prefs.removeMany(keys).ok, true, 'the remedy must work from inside the failure it remedies')

    assert.equal(prefs.set('mc.theme', 'black').ok, true,
      'settings must be saveable again once the bulk is gone')
  } finally { discard(directory) }
})

test('removeMany also works on a record that is genuinely over the ceiling', () => {
  /* Not reachable through set() (see above), but reachable if a record was
     written by a build with a different bound, or if a key that used to be
     exempt stops matching isFleetTreeKey and is reclassified as ordinary. The
     remedy must not be the one thing that cannot run in that state. */
  const { directory, file } = freshStore()
  try {
    const values = {}
    for (let index = 0; index < 20; index += 1) values[`mc.agent-recovery.v1:c:node-${index}`] = 'x'.repeat(60_000)
    fs.writeFileSync(file, `${JSON.stringify({ storageVersion: 1, values, drainedOrigins: [] })}\n`, 'utf8')

    const prefs = createRendererPrefs({ directory, fs, path, randomUUID })
    const over = Buffer.byteLength(JSON.stringify({ values: valuesOn(file) }), 'utf8')
    assert.ok(over > MAX_RECORD_BYTES, `this fixture must be genuinely over, saw ${over}`)

    const rescued = prefs.removeMany(Object.keys(values))
    assert.equal(rescued.ok, true, 'a record already over its ceiling must still be shrinkable')
    assert.equal(prefs.set('mc.theme', 'black').ok, true)
  } finally { discard(directory) }
})

test('a damaged record is not flattened by removeMany', () => {
  /* Every other mutator on this store refuses to overwrite a record it could not
     read, and sets the unreadable bytes aside first. A bulk removal must not be
     the one door that skips that. */
  const { directory, file } = freshStore()
  try {
    fs.writeFileSync(file, '{ not json at all', 'utf8')
    const prefs = createRendererPrefs({ directory, fs, path, randomUUID })

    const answer = prefs.removeMany(['anything'])

    /* Either it refuses, or it preserves the unreadable bytes first -- what it
       must NOT do is silently replace them. Both acceptable shapes are allowed
       here because this pins the PROPERTY, not the implementation's choice. */
    const preserved = fs.readdirSync(directory).some(name => name.startsWith('renderer-prefs.damaged'))
    assert.ok(answer.ok === false || preserved,
      'a bulk removal must not quietly overwrite a settings file it could not read')
  } finally { discard(directory) }
})
