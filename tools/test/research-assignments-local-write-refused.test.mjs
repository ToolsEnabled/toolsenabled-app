/* "SAVED IN THIS BROWSER" IS A PROMISE, AND THE WRITE THAT KEEPS IT COULD NOT
 * SAY IT FAILED.
 *
 * src/research-assignments.js is scrupulous everywhere else: a read that failed
 * throws ASSIGNMENTS_READ_UNAVAILABLE saying it "is not claiming that no
 * assignments exist", a row the service has not heard is returned `pending`
 * with its own sentence, and a damaged row travels in the snapshot. The local
 * WRITE was `catch {}`.
 *
 * So a full quota, a private window, or a browser with site data switched off
 * produced `{ ok: true, pending: true, sentence: 'Saved in this browser; the
 * research service has not heard it yet and will on the next visit.' }` over a
 * write that never landed. Nothing retries it either: flushPending and the next
 * visit both read the row back out of the same storage. And the caller in
 * src/views/computers.js counts every ok result into the "N sessions filed."
 * line a person reads, so the screen states a number of filings that happened
 * nowhere.
 *
 * These checks drive the real store with a storage face whose writes throw and
 * whose reads work, and assert what the caller is TOLD and what survives.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createAssignmentStore } from '../../src/research-assignments.js'

/* Reads work, writes throw -- the shape a full quota or a locked-down browser
   actually has. The map is real, so anything that DID land is visible. */
function writeRefusingStorage({ code = 'QuotaExceededError' } = {}) {
  const map = new Map()
  return {
    map,
    face: {
      getItem: key => (map.has(key) ? map.get(key) : null),
      setItem() { throw Object.assign(new Error('storage is full'), { name: code }) },
      removeItem() { throw Object.assign(new Error('storage is full'), { name: code }) },
    },
  }
}

function workingStorage() {
  const map = new Map()
  return {
    map,
    face: {
      getItem: key => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => { map.set(key, String(value)) },
      removeItem: key => { map.delete(key) },
    },
  }
}

const heardNothing = async () => ({ ok: false })
const heardIt = async (_action, { projectId, assign = [], unassign = [] }) => ({ ok: true,
  receipt: { projectId,
    assigned: assign.map(row => ({ ...row, ref: row.kind === 'all' ? '*' : row.ref, assignmentId: `ra-${projectId}-${row.kind}` })),
    unassigned: unassign.map(row => ({ ...row, projectId })),
  },
})

test('an assignment neither store kept is not reported as filed', async () => {
  const storage = writeRefusingStorage()
  const store = createAssignmentStore({ storage: storage.face, postAction: heardNothing })

  const result = await store.assign('rp-1', 'observed', 'session-9')

  assert.equal(result.ok, false, 'a filing that landed nowhere was reported as ok')
  assert.notEqual(result.pending, true, 'nothing is pending: no store holds a row to retry')
  assert.equal(typeof result.sentence, 'string')
  assert.doesNotMatch(result.sentence, /Saved in this browser/,
    `the sentence claims a save that did not happen: ${result.sentence}`)
})

test('the sentence says what to change', async () => {
  const storage = writeRefusingStorage()
  const store = createAssignmentStore({ storage: storage.face, postAction: heardNothing })
  const result = await store.assign('rp-1', 'observed', 'session-9')
  assert.match(result.sentence, /not filed anywhere|was not filed/,
    `the sentence does not say the filing did not happen: ${result.sentence}`)
  assert.match(result.sentence, /try again/i, `the sentence does not say what to do: ${result.sentence}`)
})

test('the snapshot does not show a row that exists in no store', async () => {
  const storage = writeRefusingStorage()
  const store = createAssignmentStore({ storage: storage.face, postAction: heardNothing })

  await store.assign('rp-1', 'observed', 'session-9')

  assert.deepEqual(store.snapshot().rows, [], 'the optimistic row outlived the failure that lost it')
  assert.deepEqual(store.projectsOfSession('observed', 'session-9'), [])
  assert.equal(storage.map.size, 0, 'nothing reached storage, which is the premise of this suite')
})

test('a removal this browser would not keep leaves the session filed and says so', async () => {
  const storage = workingStorage()
  const store = createAssignmentStore({ storage: storage.face, postAction: heardIt })
  assert.equal((await store.assign('rp-1', 'observed', 'session-9')).ok, true)
  assert.deepEqual(store.projectsOfSession('observed', 'session-9'), ['rp-1'])

  /* Now the browser stops accepting writes, and the service is unreachable. */
  storage.face.setItem = () => { throw Object.assign(new Error('storage is full'), { name: 'QuotaExceededError' }) }
  storage.face.removeItem = () => { throw Object.assign(new Error('storage is full'), { name: 'QuotaExceededError' }) }
  const store2 = createAssignmentStore({ storage: storage.face, postAction: heardNothing })

  const result = await store2.unassign('rp-1', 'observed', 'session-9')

  assert.equal(result.ok, false, 'a removal that landed nowhere was reported as ok')
  assert.doesNotMatch(result.sentence, /Removed in this browser/,
    `the sentence claims a removal that did not happen: ${result.sentence}`)
  assert.deepEqual(store2.projectsOfSession('observed', 'session-9'), ['rp-1'],
    'the session was shown as unfiled while it is still filed')
})

test('the service having heard it is still a success even when the browser cache did not keep it', async () => {
  /* The local row is a CACHE. If the service accepted the assignment it is
     durable there, and the next visit adopts it -- so this must not become a
     failure just because the cache write was refused. */
  const storage = writeRefusingStorage()
  const store = createAssignmentStore({ storage: storage.face, postAction: heardIt })

  const result = await store.assign('rp-1', 'observed', 'session-9')

  assert.equal(result.ok, true, 'an assignment the service accepted was reported as failed')
  assert.notEqual(result.pending, true)
})

test('the ordinary paths are unchanged: kept locally and heard, and kept locally but not heard', async () => {
  const heard = createAssignmentStore({ storage: workingStorage().face, postAction: heardIt })
  const a = await heard.assign('rp-1', 'observed', 'session-1')
  assert.deepEqual({ ok: a.ok, pending: a.pending }, { ok: true, pending: undefined })
  assert.deepEqual(heard.projectsOfSession('observed', 'session-1'), ['rp-1'])

  const unheard = createAssignmentStore({ storage: workingStorage().face, postAction: heardNothing })
  const b = await unheard.assign('rp-2', 'observed', 'session-2')
  assert.equal(b.ok, true)
  assert.equal(b.pending, true)
  assert.match(b.sentence, /Saved in this browser/)
  assert.deepEqual(unheard.projectsOfSession('observed', 'session-2'), ['rp-2'])
})
