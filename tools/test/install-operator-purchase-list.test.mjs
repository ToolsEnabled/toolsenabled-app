import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const GATE = path.join(REPO_ROOT, 'tools', 'install-operator-purchase-list.mjs')
const SUPPORT = path.join(REPO_ROOT, 'tools', 'gen-projection-lib.mjs')
const SCHEMA = path.join(REPO_ROOT, 'public', 'data', 'schema', 'purchase-catalog.schema.json')

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'install-operator-purchase-list-'))
  mkdirSync(path.join(root, 'tools'), { recursive: true })
  mkdirSync(path.join(root, 'public', 'data', 'schema'), { recursive: true })
  copyFileSync(GATE, path.join(root, 'tools', 'install-operator-purchase-list.mjs'))
  copyFileSync(SUPPORT, path.join(root, 'tools', 'gen-projection-lib.mjs'))
  copyFileSync(SCHEMA, path.join(root, 'public', 'data', 'schema', 'purchase-catalog.schema.json'))
  return root
}

function run(root, userData) {
  try {
    return {
      status: 0,
      output: execFileSync(process.execPath, [path.join(root, 'tools', 'install-operator-purchase-list.mjs'), '--userData', userData], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    }
  } catch (error) {
    return { status: error.status, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

function syntheticCatalogue() {
  return {
    version: 2,
    generatedAt: '2026-01-01T00:00:00.000Z',
    currency: 'USD',
    spendPolicy: { dailyLimitUsd: null, source: 'fixture setting', readAt: null },
    categories: [{ id: 'no-cost', label: 'Fixture', blurb: 'Synthetic test category.' }],
    items: [],
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

test('install-operator-purchase-list.mjs refuses a missing private owner list and names the gate and reason', (t) => {
  const root = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const userData = path.join(root, 'chosen-user-data')

  const result = run(root, userData)

  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /^install-operator-purchase-list: no purchase list at private[\\\\/]purchase-catalog\.owner\.json/m)
  assert.match(result.output, /deliberately not in git/)
  assert.equal(existsSync(userData), false, 'a refusal must not even create the destination directory')
})

test('install-operator-purchase-list.mjs refuses malformed JSON without replacing an installed list', (t) => {
  const root = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const userData = path.join(root, 'chosen-user-data')
  const destination = path.join(userData, 'purchase-catalog.json')
  mkdirSync(path.join(root, 'private'), { recursive: true })
  mkdirSync(userData, { recursive: true })
  writeFileSync(path.join(root, 'private', 'purchase-catalog.owner.json'), '{ not json')
  writeFileSync(destination, 'existing installation')

  const result = run(root, userData)

  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /^install-operator-purchase-list: private[\\\\/]purchase-catalog\.owner\.json is not valid JSON/m)
  assert.match(result.output, /nothing was installed/)
  assert.equal(readFileSync(destination, 'utf8'), 'existing installation')
})

test('install-operator-purchase-list.mjs refuses schema-invalid data and states why', (t) => {
  const root = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const userData = path.join(root, 'chosen-user-data')
  mkdirSync(path.join(root, 'private'), { recursive: true })
  writeFileSync(path.join(root, 'private', 'purchase-catalog.owner.json'), JSON.stringify({ version: 2 }))

  const result = run(root, userData)

  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /^install-operator-purchase-list: private[\\\\/]purchase-catalog\.owner\.json does not match the catalogue schema/m)
  assert.match(result.output, /screen would refuse it/)
  assert.equal(existsSync(path.join(userData, 'purchase-catalog.json')), false)
})

test('install-operator-purchase-list.mjs installs a valid private owner list only at the selected userData destination', (t) => {
  const root = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'private', 'purchase-catalog.owner.json')
  const userData = path.join(root, 'chosen-user-data')
  const catalogue = syntheticCatalogue()
  mkdirSync(path.dirname(source), { recursive: true })
  writeFileSync(source, JSON.stringify(catalogue))

  const result = run(root, userData)

  assert.equal(result.status, 0, result.output)
  assert.match(result.output, new RegExp(`^Installed 0 item\\(s\\) to ${escapeRegExp(userData)}[/\\\\]purchase-catalog\\.json\\.$`, 'm'))
  assert.match(result.output, /Restart ToolsEnabled/)
  assert.deepEqual(JSON.parse(readFileSync(path.join(userData, 'purchase-catalog.json'), 'utf8')), catalogue)
  assert.deepEqual(JSON.parse(readFileSync(source, 'utf8')), catalogue, 'installation must not move or alter the private source')
  assert.equal(existsSync(path.join(root, 'purchase-catalog.json')), false, 'the catalogue must not leak into the fixture root')
  assert.equal(existsSync(path.join(root, 'public', 'data', 'purchase-catalog.json')), false, 'the catalogue must not enter the public payload')
})
