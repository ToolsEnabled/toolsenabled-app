// G9 conventions: every repo path the generic-benchmark docs name (as an
// inline-code span containing a slash and a known extension) must exist.
// This is a doc/repo consistency check, not a claim that the linked test
// proves every word of its row -- only that the citation is not a dead link.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, access } from 'node:fs/promises'

const repoRoot = new URL('../../', import.meta.url)
const docs = {
  requirements: new URL('../../docs/research-generic-benchmark-requirements.md', import.meta.url),
  guide: new URL('../../docs/research-generic-templates-guide.md', import.meta.url),
}

const PATH_IN_CODE_SPAN = /`([A-Za-z0-9_.\-/]+\.(?:mjs|js|md|json))`/g

function linkedPaths(text) {
  return [...text.matchAll(PATH_IN_CODE_SPAN)].map(match => match[1])
}

async function pathExists(relativePath) {
  try { await access(new URL(relativePath, repoRoot)); return true }
  catch { return false }
}

test('every repo path linked from the requirements ledger exists', async () => {
  const text = await readFile(docs.requirements, 'utf8')
  const paths = linkedPaths(text)
  assert.ok(paths.length > 10, 'the ledger names a substantial number of linked paths: ' + paths.length)
  const missing = []
  for (const path of paths) if (!(await pathExists(path))) missing.push(path)
  assert.deepEqual(missing, [], 'every linked path must exist in the repository')
})

test('every test file named by the requirements ledger is an actual repo test file', async () => {
  const text = await readFile(docs.requirements, 'utf8')
  const testPaths = linkedPaths(text).filter(path => path.startsWith('tools/test/') && path.endsWith('.test.mjs'))
  assert.ok(testPaths.length > 10, 'the ledger names a substantial number of proving test files: ' + testPaths.length)
  const missing = []
  for (const path of testPaths) if (!(await pathExists(path))) missing.push(path)
  assert.deepEqual(missing, [], 'every named test file must exist')
})

test('the templates guide names no repo path that does not exist', async () => {
  const text = await readFile(docs.guide, 'utf8')
  const paths = linkedPaths(text)
  assert.ok(paths.length > 5, 'the guide names a substantial number of linked paths: ' + paths.length)
  const missing = []
  for (const path of paths) if (!(await pathExists(path))) missing.push(path)
  assert.deepEqual(missing, [], 'every path the guide names must exist')
})
