import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const REPO = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const RELATIVE = 'config/uac-delegation-allowlist.json'
const DEFAULT_FILE = path.join(REPO, 'capability-defaults', RELATIVE)
const STAGED_FILE = path.join(REPO, 'capability', RELATIVE)
const PAYLOAD_FILE = path.join(REPO, 'capability', 'PAYLOAD.json')

test('fresh installs carry no inherited elevated-operation authority', () => {
  const manifest = JSON.parse(readFileSync(path.join(REPO, 'tools', 'capability-manifest.json'), 'utf8'))
  const neutral = JSON.parse(readFileSync(DEFAULT_FILE, 'utf8'))

  assert.ok(manifest.dataFiles.includes(RELATIVE), 'the runtime-read allowlist must remain part of the payload')
  assert.ok(manifest.neutralDefaults.includes(RELATIVE), 'the builder allowlist must be replaced, not copied')
  assert.deepEqual(Object.keys(neutral).sort(), ['$comment', 'operations', 'schemaVersion'])
  assert.equal(neutral.schemaVersion, 1)
  assert.deepEqual(neutral.operations, [], 'installing the app must authorize zero elevated operations')
  assert.doesNotMatch(
    JSON.stringify(neutral),
    /(?:[A-Za-z0-9._-]+\\\\[A-Za-z0-9._-]+|C:\\\\Users\\\\|(?:10|127|169\.254|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3})/i,
    'the neutral default must contain no principal, profile path, or private-network address',
  )
})

test('the staged UAC allowlist is byte-identical to the neutral default', (t) => {
  if (!existsSync(PAYLOAD_FILE)) return t.skip('capability/ is not staged; pack the pinned source to exercise staged-byte equality')
  const manifest = JSON.parse(readFileSync(path.join(REPO, 'tools', 'capability-manifest.json'), 'utf8'))
  const payload = JSON.parse(readFileSync(PAYLOAD_FILE, 'utf8'))
  if (JSON.stringify(payload.neutralDefaults) !== JSON.stringify(manifest.neutralDefaults)) {
    return t.skip('capability/ predates the current manifest; pack the pinned source to exercise staged-byte equality')
  }
  assert.ok(existsSync(STAGED_FILE), 'the current packed payload omits the declared neutral UAC allowlist')
  assert.deepEqual(
    readFileSync(STAGED_FILE),
    readFileSync(DEFAULT_FILE),
    'the packer staged source-tree UAC authority instead of the empty customer default',
  )
})
