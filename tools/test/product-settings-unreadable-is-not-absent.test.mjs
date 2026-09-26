// ONE UNREADABLE MOMENT EMPTIED THE SETTINGS PAGE FOR THE WHOLE RUN.
//
// shell/product-settings.cjs answered EVERY require failure with
// SETTINGS_MODULES_ABSENT -- "the capability payload does not carry its settings
// modules" -- and settingsModules() cached ANY failure, with no exclusion at all.
// So a single EMFILE, EAGAIN, EIO or EBUSY on the first settings read decided the
// answer for the life of the process.
//
// What the person sees is the part that makes this worth fixing rather than
// noting. readProductSettings returns { ok: true, available: false, rows: [] } --
// so the window is told the call SUCCEEDED and simply has no settings to show. An
// empty Settings page, no error, nothing changeable until the app restarts, while
// the modules sit staged and healthy in the payload three inches away.
//
// The read that fails here is a require, and this product's own purpose is running
// a fleet of agents on the same machine, where descriptor exhaustion is ordinary
// rather than exotic.
//
// This is the third instance of one class in this repository, after
// canonical-audit-unreadable-is-not-absent.test.mjs (the ledger writer) and
// machine-search-path-unread-registry-retries.test.mjs (the registry). The rule
// each of them pins is the same: an answer about this ATTEMPT must never be
// cached as an answer about this INSTALLATION.
//
// NO STUB SITS ON THE CACHE PATH: settingsModules() bypasses the cache whenever
// load/root/fresh is supplied, so an injected loader would prove nothing about
// caching. The capability root is resolved the way the packaged shell resolves it,
// through process.resourcesPath, against a scratch payload whose modules throw on
// demand.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const productSettings = require('../../shell/product-settings.cjs')

// Throws with the code of a machine out of descriptors while the marker exists,
// and is a working module once it is gone. The marker is read at load time, so
// each require re-decides -- node does not cache a module whose load threw.
function moduleSource(body) {
  return [
    "const fs = require('node:fs')",
    "const path = require('node:path')",
    "if (fs.existsSync(path.join(__dirname, 'refuse-to-load'))) {",
    "  const error = new Error('EMFILE: too many open files')",
    "  error.code = 'EMFILE'",
    "  throw error",
    "}",
    body,
  ].join('\n')
}

const SETTINGS_BODY = [
  'module.exports = {',
  '  loadSettings() { return { values: {}, rejected: [] } },',
  "  resolveValuesPath() { return path.join(__dirname, 'values.json') },",
  '}',
].join('\n')

const REGISTRY_BODY = [
  'module.exports = {',
  '  loadRegistry() { return { byId: new Map(), entries: [] } },',
  '}',
].join('\n')
const MODE_BODY = 'module.exports = { normalizeSettingChange: (id, value) => ({ id, value }), settingChangesWithCompatibility: (id, value) => [{ id, value }] }'

function scratchPayload({ withModules }) {
  const root = mkdtempSync(path.join(tmpdir(), 'product-settings-unreadable-'))
  const lib = path.join(root, 'capability', 'src', 'lib')
  mkdirSync(lib, { recursive: true })
  writeFileSync(path.join(root, 'capability', 'PAYLOAD.json'), JSON.stringify({ bridgeEntrypoint: 'src/bridge.js' }))
  if (withModules) {
    writeFileSync(path.join(lib, 'settings.js'), moduleSource(SETTINGS_BODY))
    writeFileSync(path.join(lib, 'settings-registry.js'), moduleSource(REGISTRY_BODY))
    writeFileSync(path.join(lib, 'agent-api-mode.js'), moduleSource(MODE_BODY))
  }
  return { root, lib }
}

function usePayload(root, run) {
  const prior = process.resourcesPath
  process.resourcesPath = root
  productSettings.resetForTests()
  try {
    return run()
  } finally {
    productSettings.resetForTests()
    process.resourcesPath = prior
    rmSync(root, { recursive: true, force: true })
  }
}

test('settings modules that could not be READ are not reported as MISSING', () => {
  const { root, lib } = scratchPayload({ withModules: true })
  writeFileSync(path.join(lib, 'refuse-to-load'), '')
  usePayload(root, () => {
    const answer = productSettings.loadSettingsModules({})
    assert.equal(answer.ok, false)
    assert.equal(answer.code, 'SETTINGS_MODULES_UNREADABLE',
      'a transient read failure is reported as an absent settings module, which is a false statement '
      + 'about the payload')
    assert.match(answer.reason, /could not be read/,
      'the sentence still tells a reader the modules are missing')
  })
})

test('and it is NOT cached: the Settings page is not empty for the rest of the run', () => {
  const { root, lib } = scratchPayload({ withModules: true })
  const marker = path.join(lib, 'refuse-to-load')
  writeFileSync(marker, '')
  usePayload(root, () => {
    const first = productSettings.readProductSettings()
    assert.equal(first.available, false)
    assert.equal(first.rows.length, 0)

    // The machine recovers -- the modules were always there.
    rmSync(marker, { force: true })

    const second = productSettings.readProductSettings()
    assert.equal(second.available, true,
      'one unreadable moment was cached, so the Settings page stays empty and unchangeable for the life '
      + 'of the process: ' + (second.code || '') + ' ' + (second.reason || ''))
  })
})

test('genuinely absent modules are still cached -- the cache keeps doing its job', () => {
  // THE CONTROL. Without it, caching nothing would satisfy both assertions above
  // while making a copy with no settings modules pay module resolution on every
  // read, which is what the cache is for.
  const { root, lib } = scratchPayload({ withModules: false })
  usePayload(root, () => {
    const first = productSettings.readProductSettings()
    assert.equal(first.code, 'SETTINGS_MODULES_ABSENT',
      'modules genuinely not in the payload should still say so plainly')

    /* Put the modules where they were missing. A cache that is doing its job does
       NOT notice -- which is what this asserts. An earlier version of this control
       merely read the same code twice, which a module that never caches anything
       would also have satisfied, so it proved nothing about the cache it is named
       after. */
    writeFileSync(path.join(lib, 'settings.js'), moduleSource(SETTINGS_BODY))
    writeFileSync(path.join(lib, 'settings-registry.js'), moduleSource(REGISTRY_BODY))
    writeFileSync(path.join(lib, 'agent-api-mode.js'), moduleSource(MODE_BODY))

    const second = productSettings.readProductSettings()
    assert.equal(second.code, 'SETTINGS_MODULES_ABSENT',
      'the absent answer was not cached, so a copy with no settings modules pays a module resolution on '
      + 'every read -- the exact cost this cache exists to avoid')
  })
})
