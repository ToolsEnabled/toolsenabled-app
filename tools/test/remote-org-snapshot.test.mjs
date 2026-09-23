import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import facadeModule from '../../shell/agent-facade.cjs'
import surfaceModule from '../../shell/agent-command-surface.cjs'

const CHUNK = 65536
const MAX = 4 * 1024 * 1024
const makeOrg = () => ({ ok: true, org: { revision: 7, agents: [{ id: 'fixture-worker', role: 'worker' }], relationships: [] },
  roles: [{ id: 'worker', functions: ['fixture.read'], requiresDirectUserAuthorization: true }],
  functionCatalog: Array.from({ length: 248 }, (_, i) => ({ id: 'fixture.read_' + i, summary: 'Fixture 👋 ' + i,
    description: '📱 complete description '.repeat(55), inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } })),
  overlayFile: '/fixture-private/org.json', roleMemorySelection: { file: '/fixture-private/role-memory.json', source: 'account' }, ruleTextLimit: 1500 })
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

async function fixture(t, initial = makeOrg()) {
  const calls = [], state = { answer: initial, principal: { kind: 'relay', owner: { principal: 'fixture-owner-a' }, mayWrite: false } }
  const surface = { commands: Object.keys(surfaceModule.COMMANDS), sessionLoad: () => ({ open: 0, max: 8 }),
    run: async (command, payload, principal) => { calls.push({ command, payload, principal }); return state.answer } }
  const facade = facadeModule.createAgentFacade({ surface, principalForRelay: () => state.principal, log() {} })
  const { origin, token } = await facade.listen()
  t.after(() => facade.close())
  const call = async (query = '', options = {}) => {
    const response = await fetch(origin + '/v1/org' + (query ? '?' + query : ''), { method: options.method || 'GET',
      headers: { Authorization: 'Bearer ' + token, ...options.headers } })
    const bytes = Buffer.from(await response.arrayBuffer())
    assert.ok(bytes.length <= facadeModule.MAX_RESPONSE_BYTES, 'each actual HTTP response stays within the existing facade limit')
    return { status: response.status, body: JSON.parse(bytes), bytes: bytes.length }
  }
  return { call, calls, state }
}

test('complete large organisation and function schemas survive bounded real HTTP pages', async t => {
  const original = makeOrg(), f = await fixture(t, original)
  assert.ok(Buffer.byteLength(JSON.stringify(original)) > facadeModule.MAX_RESPONSE_BYTES)
  const plain = await f.call()
  assert.equal(plain.status, 500)
  assert.equal(plain.body.error.code, 'AGENT_FACADE_RESPONSE_TOO_LARGE', 'ordinary size guard remains unchanged')
  let first, chunks = []
  for (let page = 0; ; page++) {
    const answer = await f.call(new URLSearchParams({ page: String(page), ...(first ? { snapshot: first.sha256 } : {}) }))
    assert.equal(answer.status, 200)
    const part = answer.body.orgSnapshot
    first ||= part
    assert.equal(part.page, page)
    assert.equal(part.sha256, first.sha256)
    assert.equal(part.pages, first.pages)
    assert.equal(part.bytes, first.bytes)
    const chunk = Buffer.from(part.data, 'base64')
    assert.equal(chunk.length, Math.min(CHUNK, part.bytes - page * CHUNK))
    chunks.push(chunk)
    if (page + 1 === part.pages) break
  }
  const bytes = Buffer.concat(chunks), restored = JSON.parse(bytes)
  assert.equal(bytes.length, first.bytes)
  assert.equal(digest(bytes), first.sha256)
  const expected = { ...original, roleMemorySelection: { source: 'account' } }
  delete expected.overlayFile
  assert.deepEqual(restored, expected, 'all roles, function choices, full schemas and Unicode are retained')
  assert.doesNotMatch(bytes.toString(), /fixture-private/)
  assert.equal(original.roleMemorySelection.file, '/fixture-private/role-memory.json', 'projection must not mutate the native store result')
  assert.equal(original.overlayFile, '/fixture-private/org.json')
  for (const call of f.calls) {
    assert.equal(call.command, 'org:read')
    assert.deepEqual(call.payload, {}, 'transport paging is never a native command argument or account selector')
    assert.equal(call.principal.mayWrite, false)
  }
  assert.ok(first.pages > 1)
})

test('small legacy reads keep their shape and strip both known machine-only file fields', async t => {
  const f = await fixture(t, { ok: true, org: { revision: 1 }, roles: [], functionCatalog: [],
    overlayFile: '/private/overlay', roleMemorySelection: { source: 'shared', file: '/private/memory' } })
  assert.deepEqual((await f.call()).body, { ok: true, org: { revision: 1 }, roles: [], functionCatalog: [], roleMemorySelection: { source: 'shared' } })
  assert.equal(f.calls.length, 1)
})

test('Origin, bearer, method, duplicate fields and account selectors are rejected before reading', async t => {
  const f = await fixture(t)
  for (const [options, status] of [
    [{ headers: { Authorization: '' } }, 401],
    [{ headers: { Authorization: 'Bearer wrong-fixture-token' } }, 401],
    [{ headers: { Origin: 'https://toolsenabled.ai' } }, 403],
    [{ method: 'POST' }, 405],
  ]) assert.equal((await f.call('page=0', options)).status, status)
  for (const query of ['page=-1', 'page=64', 'page=1.5', 'page=0&page=1', 'page=1', 'page=1&snapshot=x',
    'snapshot=' + 'a'.repeat(64), 'page=0&snapshot=' + 'a'.repeat(64), 'page=0&account=other',
    'page=0&principal=other', 'page=0&key=secret', 'page=0&limit=2', 'page=0&__proto__=x',
    'page=0&constructor=x', 'page=0&toString=x', 'page=1&snapshot=' + 'a'.repeat(64) + '&snapshot=' + 'b'.repeat(64)]) {
    assert.equal((await f.call(query)).status, 400, query)
  }
  assert.equal(f.calls.length, 0)
})

test('a changed role or account-selected snapshot cannot continue a prior read', async t => {
  const f = await fixture(t), first = (await f.call('page=0')).body.orgSnapshot
  f.state.answer = { ...f.state.answer, roles: [{ id: 'worker', functions: [], requiresDirectUserAuthorization: true }] }
  const answer = await f.call('page=1&snapshot=' + first.sha256)
  assert.deepEqual(answer, { status: 409, body: { ok: false, error: { code: 'AGENT_FACADE_ORG_SNAPSHOT_CHANGED' } }, bytes: answer.bytes })
  f.state.principal = { kind: 'relay', owner: { principal: 'fixture-owner-b' }, mayWrite: false }
  f.state.answer = { ...makeOrg(), org: { revision: 1, agents: [{ id: 'private-fixture-b' }] } }
  assert.equal((await f.call('page=1&snapshot=' + first.sha256)).status, 409)
  assert.equal(f.calls.at(-1).principal.owner.principal, 'fixture-owner-b', 'each request uses current authority')
})

test('invalid continuation indices, oversized total snapshots and native refusals stay explicit', async t => {
  const f = await fixture(t, { ok: true, org: {}, roles: [] })
  const first = (await f.call('page=0')).body.orgSnapshot
  assert.equal((await f.call('page=1&snapshot=' + first.sha256)).status, 400)
  f.state.answer = { ok: true, org: {}, roles: [], oversized: 'x'.repeat(MAX) }
  assert.equal((await f.call('page=0')).body.error.code, 'AGENT_FACADE_RESPONSE_TOO_LARGE')
  f.state.answer = { ok: false, code: 'MC_AGENT_PRINCIPAL_NOT_OWNER', reason: 'fixture refusal' }
  assert.deepEqual((await f.call('page=0')).body, f.state.answer)
  assert.deepEqual((await f.call('page=1&snapshot=' + first.sha256)).body, f.state.answer)
})
