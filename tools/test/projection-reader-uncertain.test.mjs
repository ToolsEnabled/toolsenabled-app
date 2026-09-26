import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { loadReader } from '../gen-projection-lib.mjs'

test('loadReader distinguishes absence from an uncached could-not-check failure', t => {
  const root = mkdtempSync(join(tmpdir(), 'projection-reader-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const missing = loadReader(root, 'missing.cjs', 'missing-reader')
  assert.equal(missing.reason, 'source-missing')
  assert.equal(missing.errorCode, 'ENOENT')

  writeFileSync(join(root, 'busy.cjs'), `
    const fs = require('node:fs')
    const marker = __filename + '.retried'
    if (!fs.existsSync(marker)) {
      fs.writeFileSync(marker, '')
      const error = new Error('machine busy')
      error.code = 'EMFILE'
      throw error
    }
    module.exports = { recovered: true }
  `)
  const busy = loadReader(root, 'busy.cjs', 'busy-reader')
  assert.equal(busy.reason, 'source-reader-check-failed')
  assert.equal(busy.errorCode, 'EMFILE')
  assert.match(busy.message, /does not claim that it is absent/i)
  assert.equal(loadReader(root, 'busy.cjs', 'busy-reader').value.recovered, true,
    'a could-not-check result must not be cached or latched')

  writeFileSync(join(root, 'dependency-reader.cjs'), "module.exports = require('./late-dependency.cjs')\n")
  const dependencyUnknown = loadReader(root, 'dependency-reader.cjs', 'dependency-reader')
  assert.equal(dependencyUnknown.reason, 'source-reader-check-failed')
  assert.equal(dependencyUnknown.errorCode, 'MODULE_NOT_FOUND',
    'a missing dependency does not say that the reader itself is absent')
  assert.match(dependencyUnknown.message, /does not claim that it is absent/i)
  writeFileSync(join(root, 'late-dependency.cjs'), 'module.exports = { recovered: true }\n')
  assert.equal(loadReader(root, 'dependency-reader.cjs', 'dependency-reader').value.recovered, true,
    'a failed dependency load must remain retryable rather than becoming a latched absence')

  globalThis.__projectionReaderLoads = 0
  writeFileSync(join(root, 'cached.cjs'), `
    globalThis.__projectionReaderLoads += 1
    module.exports = { load: globalThis.__projectionReaderLoads }
  `)
  assert.equal(loadReader(root, 'cached.cjs', 'cached-reader').value.load, 1)
  assert.equal(loadReader(root, 'cached.cjs', 'cached-reader').value.load, 1,
    'successful readers retain the CommonJS cache that avoids repeated loading')
  assert.equal(globalThis.__projectionReaderLoads, 1)
  delete globalThis.__projectionReaderLoads
})
