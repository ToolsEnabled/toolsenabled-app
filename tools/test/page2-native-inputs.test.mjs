import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { optionsFrom, manifestFile, verifyPayload } from '../page2-native-audit.cjs'

test('native audit refuses missing or malformed case selections instead of silently running every paid case', () => {
  for (const args of [['--case'], ['--case', '--real-provider'], ['--case', 'setup,'], ['--level', 'unknown'], ['--unknown']]) assert.throws(() => optionsFrom(args))
  assert.deepEqual(optionsFrom(['--case', 'setup,root-start']).cases, ['setup', 'root-start'])
  assert.equal(optionsFrom([]).realProvider, false)
})

test('portable native input validation refuses escapes and ancestor links before reading the target', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'page2-native-inputs-'))
  try {
    const runtime = path.join(directory, 'runtime')
    const outside = path.join(directory, 'outside')
    fs.mkdirSync(runtime); fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'entry.cjs'), 'outside data')
    fs.writeFileSync(path.join(runtime, 'entry.cjs'), 'owned input')
    fs.symlinkSync(outside, path.join(runtime, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    for (const relative of ['../outside/entry.cjs', '/entry.cjs', 'C:/entry.cjs', '..\\outside\\entry.cjs', 'escape/entry.cjs', 'node_modules/entry.cjs', '.git/config']) {
      assert.throws(() => manifestFile(runtime, relative), /manifest paths|symbolic links|junctions/)
    }
    assert.equal(manifestFile(runtime, 'entry.cjs'), path.join(runtime, 'entry.cjs'))
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('a changed packed engine cannot retain a passing native input identity', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'page2-native-payload-'))
  try {
    const capability = path.join(directory, 'capability')
    fs.mkdirSync(capability)
    const bytes = Buffer.from('original provider code')
    const payload = { sourceRef: 'a'.repeat(40), ownerDataClean: true, fileCount: 1, byteCount: bytes.length,
      payloadSha256: crypto.createHash('sha256').update('provider.js').update('\0').update(bytes).digest('hex') }
    fs.writeFileSync(path.join(capability, 'provider.js'), bytes)
    fs.writeFileSync(path.join(capability, 'PAYLOAD.json'), JSON.stringify(payload))
    assert.equal(verifyPayload(directory).sourceRef, payload.sourceRef)
    fs.writeFileSync(path.join(capability, 'provider.js'), 'different code')
    assert.throws(() => verifyPayload(directory), /changed after packing/)
    fs.writeFileSync(path.join(capability, 'provider.js'), bytes)
    fs.writeFileSync(path.join(capability, 'extra.js'), 'extra')
    assert.throws(() => verifyPayload(directory), /inventory changed/)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('the actual native stager refuses missing or empty renderer assets even when their portable manifest hashes agree', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'page2-native-renderer-'))
  const stager = fileURLToPath(new URL('../page2-native-audit.cjs', import.meta.url))
  const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
  try {
    for (const state of ['healthy', 'missing', 'empty']) {
      const source = path.join(directory, state, 'source'), destination = path.join(directory, state, 'staged')
      const modules = path.join(directory, state, 'dependencies')
      for (const root of [source, destination, modules]) fs.mkdirSync(root, { recursive: true })
      // A synthetic artifact exercises only staging. No Electron, provider,
      // private owner input, or product-success verdict is involved here.
      const provider = Buffer.from('owned payload fixture')
      const sourceHash = 'c'.repeat(64), engineRef = 'b'.repeat(40)
      const content = {
        'capability/provider.js': provider,
        'capability/PAYLOAD.json': JSON.stringify({ sourceRef: engineRef, ownerDataClean: true, fileCount: 1, byteCount: provider.length,
          payloadSha256: crypto.createHash('sha256').update('provider.js').update('\0').update(provider).digest('hex') }),
        'dist/.dist-source.json': JSON.stringify({ sourceHash }),
        'dist/index.html': '<script type="module" src="/assets/index-fixture.js"></script>',
        ...(state === 'missing' ? {} : { 'dist/assets/index-fixture.js': state === 'empty' ? '' : 'export const fixture = true' }),
      }
      for (const [relative, bytes] of Object.entries(content)) {
        const file = path.join(source, relative)
        fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes)
      }
      fs.writeFileSync(path.join(source, 'PAGE2-NATIVE-INPUTS.json'), JSON.stringify({ schemaVersion: 1, appRef: 'a'.repeat(40), engineRef, rendererSourceHash: sourceHash,
        files: Object.fromEntries(Object.entries(content).map(([relative, bytes]) => [relative, digest(bytes)])),
        modes: Object.fromEntries(Object.keys(content).map(relative => [relative, 0o600])),
      }))
      const result = spawnSync(process.execPath, ['-e', `require(process.argv[1]).stageApplication(...process.argv.slice(2)).then(() => process.stdout.write('staged')).catch(error => { process.stderr.write(error.stack); process.exitCode = 2 })`, stager, source, destination, modules], { encoding: 'utf8', timeout: 10000 })
      assert.equal(result.error, undefined)
      assert.equal(result.signal, null)
      assert.equal(result.status, state === 'healthy' ? 0 : 2, `${state}: ${result.stdout}\n${result.stderr}`)
      if (state === 'healthy') {
        assert.equal(result.stdout, 'staged')
        assert.ok(fs.existsSync(path.join(destination, 'runtime', 'PAGE2-NATIVE-INPUTS.json')))
      } else {
        assert.match(result.stderr, /HARNESS REFUSAL/)
        assert.match(result.stderr, state === 'missing' ? /named but not in the copy/ : /ZERO BYTES/)
        assert.equal(result.stdout, '')
        assert.equal(fs.existsSync(path.join(destination, 'runtime', 'PAGE2-NATIVE-INPUTS.json')), false,
          'a torn renderer must not receive a new passing input manifest')
      }
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
