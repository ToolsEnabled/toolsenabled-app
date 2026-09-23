import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { collectProviderRuntimePayload, readPinnedRuntimeFile } from '../lib/provider-runtime-payload.mjs'

const declarations = [{ id: 'gemini-quota', manifest: 'config/gemini-quota-runtime.json' }]
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-runtime-payload-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const data = Buffer.from('export const sdk = true;\n')
  const file = 'provider-runtimes/gemini-quota/sdk.mjs'
  const pin = { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }
  const manifest = { schemaVersion: 1, id: 'gemini-quota', version: '0.58.0', runtimePath: 'provider-runtimes/gemini-quota', entrypoint: 'sdk.mjs', files: { 'sdk.mjs': pin } }
  fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true })
  fs.mkdirSync(path.join(root, 'config'))
  fs.writeFileSync(path.join(root, file), data)
  const save = () => fs.writeFileSync(path.join(root, declarations[0].manifest), JSON.stringify(manifest))
  save()
  return { root, file, pin, data, manifest, save }
}

test('only declared hash-pinned runtime bytes and their committed manifest join the payload', t => {
  const f = fixture(t)
  const result = collectProviderRuntimePayload(f.root, declarations)
  assert.deepEqual(result.files, [declarations[0].manifest, f.file])
  assert.equal(result.records[0].fileCount, 1)
  assert.deepEqual(readPinnedRuntimeFile(f.root, f.file, result.pins.get(f.file)), f.data)
})

for (const mode of ['same-size-tamper', 'missing', 'undeclared-file', 'nested-link', 'path-escape', 'invalid-pin', 'missing-entrypoint', 'wrong-root', 'wrong-version']) {
  test(`runtime staging refuses ${mode}`, t => {
    const f = fixture(t)
    if (mode === 'same-size-tamper') fs.writeFileSync(path.join(f.root, f.file), Buffer.alloc(f.data.length, 120))
    if (mode === 'missing') fs.unlinkSync(path.join(f.root, f.file))
    if (mode === 'undeclared-file') fs.writeFileSync(path.join(f.root, path.dirname(f.file), 'auth.json'), '{}')
    if (mode === 'nested-link') fs.symlinkSync(path.join(f.root, 'config'), path.join(f.root, path.dirname(f.file), 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    if (mode === 'path-escape') f.manifest.files['../outside.js'] = f.pin
    if (mode === 'invalid-pin') f.manifest.files['sdk.mjs'].sha256 = 'not-a-hash'
    if (mode === 'missing-entrypoint') f.manifest.entrypoint = 'missing.mjs'
    if (mode === 'wrong-root') f.manifest.runtimePath = 'somewhere-else'
    if (mode === 'wrong-version') f.manifest.version = 'latest'
    f.save()
    assert.throws(() => collectProviderRuntimePayload(f.root, declarations))
  })
}

test('mutation after initial inventory is refused again immediately before staging', t => {
  const f = fixture(t)
  const result = collectProviderRuntimePayload(f.root, declarations)
  fs.writeFileSync(path.join(f.root, f.file), Buffer.alloc(f.data.length, 121))
  assert.throws(() => readPinnedRuntimeFile(f.root, f.file, result.pins.get(f.file)), /hash changed/)
})

test('no runtime declaration preserves the existing payload contract', () => {
  const result = collectProviderRuntimePayload('unused', [])
  assert.deepEqual(result.files, [])
  assert.deepEqual(result.records, [])
})
