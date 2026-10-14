'use strict'

/* The dual engine stands in for the paired engine's processes only. Model
   identifiers and efforts stay the paired engine's own: the host validates every
   model choice through <engine>/src/lib/model-dispatch-tiers.js, so this fixture
   forwards to the real table, found the way tools/canonical-root.mjs finds it. */
const fs = require('node:fs')
const path = require('node:path')

const appRoot = path.resolve(__dirname, '../../../../../..')

function pairedEngineRoot() {
  for (const name of ['MC_CANONICAL_ROOT', 'TOOLSENABLED_SOURCE']) {
    const value = typeof process.env[name] === 'string' ? process.env[name].trim() : ''
    if (value) return path.resolve(value)
  }
  try {
    const configured = JSON.parse(fs.readFileSync(path.join(appRoot, 'private', 'capability-source.owner.json'), 'utf8'))
    if (typeof configured?.path === 'string' && configured.path.trim()) return path.resolve(configured.path.trim())
  } catch {}
  return path.join(appRoot, 'capability')
}

module.exports = require(path.join(pairedEngineRoot(), 'src', 'lib', 'model-dispatch-tiers.js'))
