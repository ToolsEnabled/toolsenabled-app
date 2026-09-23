'use strict'

// FIXTURE runtime: only what the copied r-ledger module requires -- rootPath.
// The real engine decides program-vs-state roots in src/lib/runtime-state-root;
// here the tests own the root outright through MC_TEST_STATE_ROOT, so a test
// can plant, read and destroy ledgers without touching anything real.
const path = require('node:path')

function rootPath(...parts) {
  const root = process.env.MC_TEST_STATE_ROOT || path.join(__dirname, '..', '..', 'state-root')
  return path.join(root, ...parts)
}

module.exports = { rootPath }
