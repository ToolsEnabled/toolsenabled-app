'use strict'

// FIXTURE runtime-state-root: only what the copied owner-request-store module
// requires -- statePath. The real engine decides program-vs-state roots in
// src/lib/runtime-state-root; here the tests own the root outright through
// MC_TEST_STATE_ROOT (the same rule ./runtime.js applies to rootPath), so a
// test can plant, read and destroy ledgers without touching anything real.
const { rootPath } = require('./runtime')

function statePath(...parts) {
  return rootPath(...parts)
}

module.exports = { statePath, stateRoot: () => rootPath() }
