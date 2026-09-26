import test from 'node:test'
import assert from 'node:assert/strict'

const notices = []
const storageReads = []
const localStorage = {
  getItem(key) {
    storageReads.push(key)
    if (key === 'mc.fleet.profile') throw new Error('profile disk is unavailable')
    return null
  },
  setItem() {},
  removeItem() {},
}

globalThis.localStorage = localStorage
globalThis.document = {
  body: { appendChild(node) { notices.push(node) } },
  querySelector() { return null },
  createElement(tagName) {
    return {
      tagName,
      dataset: {},
      className: '',
      classList: { toggle(name, on) { this[name] = on } },
      setAttribute(name, value) { this[name] = value },
    }
  },
  addEventListener() {},
}

const fleetProfile = await import('../../src/fleet-profile.js')

function callerProfile() {
  return {
    schemaVersion: 1,
    id: 'studio-fleet',
    label: 'Studio fleet',
    machines: [{ id: 'render-1', name: 'Render station', address: 'renderbox.local' }],
    transports: [{ id: 'relay', endpoint: 'relay.local:7443', port: 7443 }],
    dataSource: { kind: 'directory', path: '/srv/fleet-projection' },
  }
}

test('settings-shaped profiles validate and survive export/import', () => {
  const profile = callerProfile()
  const verdict = fleetProfile.validateFleetProfile(profile)
  assert.equal(verdict.ok, true, 'a profile assembled by the settings form must validate')

  const serialized = fleetProfile.serializeFleetProfile(profile)
  assert.equal(serialized.ok, true, 'a valid settings profile must be exportable')
  const parsed = fleetProfile.parseFleetProfile(serialized.text)
  assert.equal(parsed.ok, true, 'an exported profile must be importable again')
  assert.deepEqual(parsed.profile, profile, 'export and import must preserve the operator profile')
})

test('malformed imports are a refusal with an actionable reason', () => {
  const parsed = fleetProfile.parseFleetProfile('{"schemaVersion": 1,')
  assert.equal(parsed.ok, false, 'malformed JSON must be refused rather than treated as a profile')
  assert.ok(parsed.errors.some(error => error.path === '$' && /JSON|malformed/i.test(error.message)),
    'the import refusal must identify malformed JSON at the profile root')
})

test('an unreadable saved profile stays indeterminate and visibly falls back', () => {
  assert.ok(storageReads.includes(fleetProfile.FLEET_PROFILE_STORAGE_KEY),
    'startup must attempt to read the saved fleet profile')
  assert.equal(fleetProfile.FLEET_PROFILE_RESOLUTION.kind, 'invalid',
    'a storage read failure must not collapse into a definite unconfigured answer')
  assert.equal(fleetProfile.FLEET_PROFILE_RESOLUTION.configured, false,
    'an unreadable profile must not be represented as a configured fleet')
  assert.ok(fleetProfile.FLEET_PROFILE_RESOLUTION.errors.some(error =>
    error.source === 'browser storage' && /could not be read/i.test(error.message)),
  'the resolution must retain the storage read failure for the settings UI')

  assert.equal(notices.length, 1, 'the fallback must be announced once')
  assert.equal(notices[0].role, 'alert', 'the unreadable-profile fallback must be an alert')
  assert.match(notices[0].textContent, /not loaded/i,
    'the alert must say the operator profile was not loaded')
  assert.match(notices[0].textContent, /sample|demonstration/i,
    'the alert must disclose that sample data replaced the unreadable profile')
})

test('a failed durable save is refused without claiming or attempting a browser mirror', async () => {
  let mirrorWrites = 0
  globalThis.localStorage = { setItem() { mirrorWrites += 1 } }
  globalThis.mcFleetProfile = {
    async save() { return { ok: false, error: { message: 'volume is read-only' } } },
  }

  const result = await fleetProfile.persistFleetProfile(callerProfile())
  assert.equal(result.ok, false, 'a failed durable save must be reported as a failed save')
  assert.equal(mirrorWrites, 0, 'a failed durable save must not write a misleading browser mirror')
  assert.ok(result.errors.some(error =>
    error.source === 'durable storage' && /volume is read-only/i.test(error.message)),
  'the save refusal must preserve the durable failure reason')
})
