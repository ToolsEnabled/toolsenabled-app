import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..', '..')

async function loadQueueFunctions() {
  const source = readFileSync(resolve(ROOT, 'src/views/research.js'), 'utf8')
    .replace(/^import .*$/gm, '')
  const instrumented = `${source}\nexport { fetchResearchQueue, researchQueueMarkup }\n`
  return import(`data:text/javascript;base64,${Buffer.from(instrumented).toString('base64')}`)
}

const { fetchResearchQueue, researchQueueMarkup } = await loadQueueFunctions()

function queueItem(index, overrides = {}) {
  return {
    id: `item-${index}`,
    title: `Research item ${index}`,
    status: 'queued',
    provenance: 'owner-observation',
    observation: `Observation ${index}`,
    researchQuestion: `Question ${index}?`,
    ...overrides,
  }
}

function fetchFor(payload) {
  return async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    async json() { return structuredClone(payload) },
  })
}

const fetchQueue = payload => fetchResearchQueue({ fetchImpl: fetchFor(payload) })

test('one corrupt item does not blank the other sixteen', async () => {
  const items = Array.from({ length: 17 }, (_, index) => queueItem(index))
  items[9].title = ''

  const result = await fetchQueue({ schemaVersion: 1, items })

  assert.equal(result.ok, true)
  assert.equal(result.items.length, 16)
  assert.equal(result.rejected.length, 1)
  assert.deepEqual(result.rejected[0], {
    index: 9,
    id: 'item-9',
    reason: 'missing or invalid title',
  })
})

test('a later duplicate id is rejected while the first and the rest render', async () => {
  const items = [
    queueItem(0, { title: 'First occurrence' }),
    queueItem(1, { id: 'item-0', title: 'Later duplicate' }),
    queueItem(2, { title: 'Unaffected item' }),
  ]

  const result = await fetchQueue({ schemaVersion: 1, items })

  assert.equal(result.ok, true)
  assert.deepEqual(result.items.map(item => item.title), ['First occurrence', 'Unaffected item'])
  assert.deepEqual(result.rejected, [{ index: 1, id: 'item-0', reason: 'duplicate id' }])
  const markup = researchQueueMarkup(result)
  assert.match(markup, /First occurrence/)
  assert.match(markup, /Unaffected item/)
  assert.doesNotMatch(markup, /Later duplicate/)
  assert.doesNotMatch(markup, /\[object Object\]/)
})

test('all invalid items produce an available result with a visible rejection notice', async () => {
  const result = await fetchQueue({
    schemaVersion: 1,
    items: [null, queueItem(1, { id: '' }), queueItem(2, { status: 'mystery' })],
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.items, [])
  assert.equal(result.rejected.length, 3)
  const markup = researchQueueMarkup(result)
  assert.match(markup, /All 3 research queue items were rejected\./)
  assert.match(markup, /queue item must be an object/)
  assert.match(markup, /missing or invalid id/)
  assert.match(markup, /unknown status/)
  assert.doesNotMatch(markup, /Research queue unavailable/)
})

test('whole-payload failures still refuse the queue', async t => {
  await t.test('bad JSON', async () => {
    const result = await fetchResearchQueue({
      fetchImpl: async () => ({
        ok: true,
        async json() { throw new SyntaxError('bad JSON') },
      }),
    })
    assert.equal(result.ok, false)
  })

  for (const [name, payload] of [
    ['wrong schema version', { schemaVersion: 2, items: [] }],
    ['items absent', { schemaVersion: 1 }],
    ['more than 1000 items', {
      schemaVersion: 1,
      items: Array.from({ length: 1001 }, (_, index) => queueItem(index)),
    }],
  ]) {
    await t.test(name, async () => {
      const result = await fetchQueue(payload)
      assert.equal(result.ok, false)
    })
  }
})

test('mixed markup keeps valid rows visible and reports rejection without raw item content', async () => {
  const rejectedTitle = '<RAW REJECTED TITLE>'
  const rejectedStatus = '<RAW REJECTED STATUS>'
  const rejectedObservation = '<RAW REJECTED OBSERVATION>'
  const result = await fetchQueue({
    schemaVersion: 1,
    items: [
      queueItem(0, { title: 'Visible survivor' }),
      queueItem(1, {
        title: rejectedTitle,
        status: rejectedStatus,
        observation: rejectedObservation,
      }),
    ],
  })

  assert.equal(result.ok, true)
  assert.equal(result.items.length, 1)
  assert.deepEqual(result.rejected, [{ index: 1, id: 'item-1', reason: 'unknown status' }])
  const markup = researchQueueMarkup(result)
  assert.match(markup, /Visible survivor/)
  assert.match(markup, /1 research queue item was rejected\./)
  assert.match(markup, /Source index 1 · id item-1: unknown status/)
  assert.doesNotMatch(markup, /RAW REJECTED TITLE|RAW REJECTED STATUS|RAW REJECTED OBSERVATION/)
})

test('a legitimately empty queue keeps the existing empty state', async () => {
  const result = await fetchQueue({ schemaVersion: 1, items: [] })

  assert.deepEqual(result, { ok: true, items: [], rejected: [] })
  const markup = researchQueueMarkup(result)
  assert.match(markup, /No research items are queued\./)
  assert.doesNotMatch(markup, /data-research-queue-rejections/)
})
