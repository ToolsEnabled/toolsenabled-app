import assert from 'node:assert/strict'
import test from 'node:test'
import { csvRows, textChunks, inspectPackage, inspectSchema, decodeValue, readTablePage, validateTable, relativeDataPath } from '../../src/research-data-package.mjs'

const stream = text => new Blob([text]).stream()
const schema = { fields: [{ name: 'id', type: 'integer' }, { name: 'text', type: 'string' }, { name: 'value', type: 'number' }], primaryKey: ['id'] }
const resource = { schema, delimiter: ',' }

test('CSV quoting survives every possible chunk split, CRLF, escaped quotes and embedded newlines', async () => {
  const csv = '\uFEFFid,text,value\r\n1,"a,b",2\r\n2,"a""b\ncontinued",3\r\n3,,4'
  for (let split = 0; split <= csv.length; split++) {
    const rows = []
    for await (const row of csvRows([csv.slice(0, split), csv.slice(split)])) rows.push(row)
    assert.deepEqual(rows, [['id', 'text', 'value'], ['1', 'a,b', '2'], ['2', 'a"b\ncontinued', '3'], ['3', '', '4']])
  }
})
test('malformed quotes and invalid UTF-8 fail explicitly', async () => {
  for (const csv of ['id\n"never closed', 'id\n"closed"tail', 'id\na"b']) {
    await assert.rejects(async () => { for await (const _row of csvRows([csv])) {} })
  }
  await assert.rejects(async () => { for await (const _text of textChunks(new Blob([new Uint8Array([0xff])]).stream())) {} })
})
test('large integer IDs preserve every digit; blank and zero remain distinct', () => {
  assert.equal(decodeValue('18446744073709551615', { name: 'id', type: 'integer' }, {}), 18446744073709551615n)
  assert.equal(decodeValue('', { type: 'number' }, {}), null)
  assert.equal(decodeValue('0', { type: 'number' }, {}), 0)
  assert.throws(() => decodeValue('1,000', { type: 'number' }, {}))
  assert.throws(() => decodeValue('Infinity', { type: 'number' }, {}))
})
test('dates reject rollover and timestamps require timezone while retaining subsecond precision', () => {
  assert.throws(() => decodeValue('2026-02-30', { type: 'date' }, {}))
  assert.throws(() => decodeValue('2026-01-01T12:00:00', { type: 'datetime' }, {}))
  assert.equal(decodeValue('2026-01-01T12:00:00.123456789Z', { type: 'datetime' }, {}), '2026-01-01T12:00:00.123456789Z')
})
test('typed page preserves original cells and gives exact row/column errors', async () => {
  const result = await readTablePage(stream('id,text,value\n1,hello,2\n2,world,nope\n3,,0\n'), resource)
  assert.equal(result.rows[1].cells[2], 'nope')
  assert.equal(result.rows[2].values[2], 0)
  assert.equal(result.rows[2].values[1], null)
  assert.deepEqual(result.errors.map(e => [e.row, e.column]), [[3, 'value']])
  assert.equal(result.scanned, 3)
})
test('pagination and filtering report their coverage without declaring the whole file validated', async () => {
  const text = 'id,text,value\n' + Array.from({ length: 205 }, (_, i) => `${i},${i % 2 ? 'odd' : 'even'},${i}\n`).join('')
  const first = await readTablePage(stream(text), resource, { limit: 100 })
  assert.equal(first.hasMore, true); assert.equal(first.complete, false); assert.equal(first.rows.length, 100)
  const last = await readTablePage(stream(text), resource, { offset: 200 })
  assert.equal(last.rows.length, 5); assert.equal(last.hasMore, false); assert.equal(last.matched, 205)
  const filtered = await readTablePage(stream(text), resource, { search: 'odd', offset: 100 })
  assert.equal(filtered.rows.length, 2); assert.equal(filtered.matched, 102)
})
test('full file validation finds duplicates, required fields and ragged records beyond the first page', async () => {
  const text = 'id,text,value\n' + Array.from({ length: 101 }, (_, i) => `${i},x,1\n`).join('') + '100,x,2\n,x,2\n102,x\n'
  const result = await validateTable(stream(text), resource)
  assert.equal(result.count, 104)
  assert.ok(result.errors.some(e => e.row === 103 && /Duplicate/.test(e.message)))
  assert.ok(result.errors.some(e => e.column === 'id' && /required/.test(e.message)))
  assert.ok(result.errors.some(e => /cells/.test(e.message)))
})
test('exact headers reject order mismatches; equal mapping decodes by name', async () => {
  await assert.rejects(readTablePage(stream('text,id,value\nhello,1,2'), resource), /order/)
  const result = await readTablePage(stream('text,id,value\nhello,1,2'), { ...resource, schema: { ...schema, fieldsMatch: 'equal' } })
  assert.deepEqual(result.rows[0].values, [1, 'hello', 2])
})
test('package paths cannot escape a selected folder and unsupported schemas are explicit refusals', () => {
  for (const path of ['../secret', '/etc/passwd', 'C:\\secret', 'data/%2e%2e/secret', 'https://host/file']) assert.throws(() => relativeDataPath(path))
  assert.equal(relativeDataPath('data/measurements.csv'), 'data/measurements.csv')
  assert.throws(() => inspectSchema({ fields: [{ name: 'a', type: 'unknown' }] }), /supported/)
  assert.throws(() => inspectSchema({ fields: [{ name: 'a', type: 'string' }, { name: 'a', type: 'string' }] }), /unique/)
  const tables = inspectPackage({ resources: [{ name: 'observations', path: ['data/a.csv', 'data/b.csv'], schema }] })
  assert.equal(tables[0].paths.length, 2)
})
test('cancelled reads cannot produce a success result', async () => {
  const abort = new AbortController(); abort.abort()
  await assert.rejects(readTablePage(stream('id,text,value\n1,x,1'), resource, { signal: abort.signal }), { name: 'AbortError' })
})

test('schema mistakes fail before reading rows and timestamp ranges compare actual instants', async () => {
  for (const constraints of [{ required: 'false' }, { unique: 1 }, { minimum: '0' }, { enum: 'a' }]) {
    assert.throws(() => inspectSchema({ fields: [{ name: 'value', type: 'number', constraints }] }))
  }
  const field = { name: 'time', type: 'datetime', constraints: { minimum: '2026-01-01T12:00:00.123456789Z' } }
  inspectSchema({ fields: [field] })
  assert.throws(() => decodeValue('2026-01-01T14:00:00.123456788+02:00', field, {}), /range/)
  assert.equal(decodeValue('2026-01-01T14:00:00.123456789+02:00', field, {}), '2026-01-01T14:00:00.123456789+02:00')
  const temporal = { schema: { fields: [{ name: 'time', type: 'datetime' }], primaryKey: 'time' } }
  const result = await validateTable(stream('time\n2026-01-01T12:00:00.123456789Z\n2026-01-01T14:00:00.123456789+02:00\n'), temporal)
  assert.equal(result.errorCount, 1)
  assert.match(result.errors[0].message, /Duplicate/)
})

// exist all left every assertion green. These assert the wiring, by value.
test('the descriptor reader applies the path rule to every declared data file, not just to the helper', () => {
  const ok = { fields: [{ name: 'id', type: 'integer' }] }
  for (const path of ['../secret.csv', '/etc/passwd', 'data/../../secret.csv', 'https://host/file.csv']) {
    assert.throws(() => inspectPackage({ resources: [{ name: 'observations', path, schema: ok }] }), /relative file path/,
      `a resource declaring ${path} must be refused`)
    assert.throws(() => inspectPackage({ resources: [{ name: 'observations', path: ['data/fine.csv', path], schema: ok }] }), /relative file path/,
      `a later path in the list is checked too: ${path}`)
  }
  assert.throws(() => inspectPackage({ resources: [{ name: 'observations', path: 'data/a.csv', schema: '../schema.json' }] }), /relative file path/)
  assert.equal(inspectPackage({ resources: [{ name: 'observations', path: 'data/a.csv', schema: ok }] })[0].paths[0], 'data/a.csv')
})

test('a schema naming a constraint or primary key the reader cannot honour is refused, not ignored', () => {
  assert.throws(() => inspectSchema({ fields: [{ name: 'a', type: 'string', constraints: { madeUp: 1 } }] }), /unsupported constraint/,
    'a constraint the reader will not enforce cannot pass silently, or the file looks checked when it is not')
  assert.throws(() => inspectSchema({ fields: [{ name: 'a', type: 'string' }], primaryKey: ['absent'] }), /primary key/)
  assert.throws(() => inspectSchema({ fields: [{ name: 'a', type: 'string' }], primaryKey: ['a', 'absent'] }), /primary key/)
  const accepted = inspectSchema({ fields: [{ name: 'a', type: 'string', constraints: { required: true } }], primaryKey: ['a'] })
  assert.equal(accepted.fields[0].name, 'a')
})
