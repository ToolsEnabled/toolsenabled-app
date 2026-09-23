import test from 'node:test'
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { verifyVoiceBundle, checkedPath } from '../prepare-voice-runtime.mjs'
import beforePack from '../before-pack-voice.cjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const tempPrefix = path.join(ownedFixtureTempRoot(), 'toolsenabled-voice-bundle-test-')
function fixture(t) {
  const root = fs.mkdtempSync(tempPrefix)
  t.after(() => { assert.ok(path.resolve(root).startsWith(path.resolve(tempPrefix))); fs.rmSync(root, { recursive: true, force: true }) })
  const source = path.join(root, 'voice-runtime'), bundle = path.join(source, 'bundle')
  fs.mkdirSync(bundle, { recursive: true })
  const manifest = { schemaVersion: 1, platform: 'win32', arch: 'x64', pythonVersion: '3.13.3', files: [], workerSource: {} }
  function write(name, content) {
    const file = path.join(bundle, name)
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content)
    const record = { path: name, bytes: Buffer.byteLength(content), sha256: sha(content) }
    manifest.files = manifest.files.filter(entry => entry.path !== name).concat(record)
  }
  for (const name of ['runtime.json', 'python/python.exe', 'python/python313.dll', 'python/python313._pth', 'python/LICENSE.txt', 'python/Lib/encodings/__init__.py']) write(name, 'fixture')
  write('python/python313._pth', '.\nLib\nDLLs\nLib\\site-packages\n..\\..\nimport site\n')
  write('runtime.json', JSON.stringify({ schemaVersion: 1, platform: 'win32', arch: 'x64', pythonVersion: '3.13.3' }))
  write('models/fixture.bin', 'pinned model fixture')
  write('notices/fixture-source.txt', 'source and notices')
  write('python/Lib/site-packages/fixture_lib-1.0.0.dist-info/METADATA', 'Name: fixture-lib\nVersion: 1.0.0\n')
  const sources = { 'worker.py': '# fixture', 'requirements.lock.txt': 'fixture-lib==1.0.0\n', 'redistribution-assets.json': JSON.stringify({ files: [{ path: 'fixture-source.txt', bytes: Buffer.byteLength('source and notices'), sha256: sha('source and notices') }] }), 'model-assets.json': JSON.stringify({ files: [{ path: 'fixture.bin', bytes: 20, sha256: sha('pinned model fixture') }] }) }
  for (const [name, contents] of Object.entries(sources)) { fs.writeFileSync(path.join(source, name), contents); manifest.workerSource[name] = sha(contents) }
  manifest.requirementsSha256 = manifest.workerSource['requirements.lock.txt']
  const seal = () => fs.writeFileSync(path.join(bundle, 'bundle-manifest.json'), JSON.stringify(manifest))
  seal()
  return { root, source, bundle, manifest, write, seal }
}

test('artifact verification examines real copied bytes and rejects removal/corruption', async t => {
  const f = fixture(t)
  await verifyVoiceBundle(f.bundle, f.source)
  fs.writeFileSync(path.join(f.bundle, 'models/fixture.bin'), 'corrupt')
  await assert.rejects(verifyVoiceBundle(f.bundle, f.source), /integrity failed/)
  f.write('models/fixture.bin', 'pinned model fixture'); f.seal()
  fs.unlinkSync(path.join(f.bundle, 'python/python.exe'))
  await assert.rejects(verifyVoiceBundle(f.bundle, f.source), /ENOENT/)
})

test('recomputed bundle records cannot approve a different pinned model', async t => {
  const f = fixture(t)
  f.write('models/fixture.bin', 'different model here'); f.seal()
  await assert.rejects(verifyVoiceBundle(f.bundle, f.source), /pinned model/)
})

test('unlisted owner cache bytes and stale worker source prevent packaging', async t => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.bundle, 'unexpected-cache'), 'must not ship')
  await assert.rejects(verifyVoiceBundle(f.bundle, f.source), /unlisted files/)
  fs.unlinkSync(path.join(f.bundle, 'unexpected-cache'))
  fs.writeFileSync(path.join(f.source, 'worker.py'), '# changed worker')
  await assert.rejects(verifyVoiceBundle(f.bundle, f.source), /source changed/)
})

test('manifest traversal and declared-root escapes are refused', async t => {
  const f = fixture(t)
  f.manifest.files[0].path = '../outside'; f.seal()
  await assert.rejects(verifyVoiceBundle(f.bundle, f.source), /Invalid speech bundle file entry/)
  assert.throws(() => checkedPath(f.source, path.join(f.root, 'outside')), /leaves its declared root/)
})

test('recomputed records cannot introduce machine Python search paths', async t => {
  const f = fixture(t)
  f.write('python/python313._pth', 'C:\\Python313\\Lib\nimport site\n'); f.seal()
  await assert.rejects(verifyVoiceBundle(f.bundle, f.source), /not portable and isolated/)
})

test('artifact packaging requires the exact notices and locked distribution versions', async t => {
  const f = fixture(t)
  f.write('notices/fixture-source.txt', 'wrong source'); f.seal()
  await assert.rejects(verifyVoiceBundle(f.bundle, f.source), /pinned notice\/source/)
  f.write('notices/fixture-source.txt', 'source and notices')
  f.write('python/Lib/site-packages/fixture_lib-1.0.0.dist-info/METADATA', 'Name: fixture-lib\nVersion: 2.0.0\n'); f.seal()
  await assert.rejects(verifyVoiceBundle(f.bundle, f.source), /unlocked or duplicate distribution/)
})

/* THE INSTALLER SHIPS WITHOUT LOCAL SPEECH, AND THAT IS THE APPROVED DESIGN.
 *
 * Owner decision OD7, and B23c: "the person approved a SEPARATE hash-manifested
 * speech pack as an opt-in download, a second public unit beside the installer,
 * and 1.0.42 may ship without the pack if unmeasured". So a build with no bundle
 * and no owner config is the DEFAULT, not a failure -- this hook's old message,
 * "Local speech must be included in the Windows installer", encoded the previous
 * design and blocked every cut once the bundle stopped being staged in-tree.
 *
 * What must NOT relax is the licence gate. If a bundle IS present it is still
 * verified in full, and the pinned notices and GPL corresponding source are part
 * of that verification -- asserted here through the hook, not only through
 * verifyVoiceBundle directly, because the hook is what the build actually calls. */
test('the Windows builder hook builds without speech, and still verifies a bundle that is present', async t => {
  const f = fixture(t)

  // 1. No bundle, no owner config: the approved default. It must RESOLVE.
  const bare = { electronPlatformName: 'win32', packager: { projectDir: path.join(f.root, 'empty-project') } }
  await beforePack(bare)

  // 2. A bundle that is present is still verified end to end.
  const context = { electronPlatformName: 'win32', packager: { projectDir: f.root } }
  await beforePack(context)

  // 3. Corrupted payload bytes still refuse.
  fs.writeFileSync(path.join(f.bundle, 'models/fixture.bin'), 'corrupt')
  await assert.rejects(beforePack(context), /integrity failed/)
})

/* THE OPT-IN PACK PATH MUST STILL WORK -- a complete bundle packs.
 *
 * The bundle-less default is what changed; this is the case that proves the change
 * did not break the path it left alone. It uses the REAL eight redistribution
 * asset names with fixture-sized contents, never the 5.5 GB payload.
 *
 * Eight rather than the base fixture's one is not padding. With a single pinned
 * notice, a rule that checked only `notices.files[0]` would pass every test in
 * this file; the eight-asset case is what makes "every pinned asset is checked"
 * falsifiable, which is why the refusal case below corrupts the LAST of the eight
 * and not the first. */
const REDISTRIBUTION_ASSETS = [
  'espeak-ng-1.52.0-source.tar.gz',
  'espeakng-loader-0.2.4-source.tar.gz',
  'espeak-ng-GPL-3.0.txt',
  'espeakng-loader-MIT.txt',
  'whisper-model-card.md',
  'whisper-MIT.txt',
  'kokoro-model-card.md',
  'kokoro-Apache-2.0.txt',
]

function withAllRedistributionAssets(f) {
  const declared = REDISTRIBUTION_ASSETS.map(name => {
    const contents = `fixture contents of ${name}`
    f.write(`notices/${name}`, contents)
    return { path: name, bytes: Buffer.byteLength(contents), sha256: sha(contents) }
  })
  const manifestJson = JSON.stringify({ files: declared })
  fs.writeFileSync(path.join(f.source, 'redistribution-assets.json'), manifestJson)
  f.manifest.workerSource['redistribution-assets.json'] = sha(manifestJson)
  /* The single-asset entry the base fixture staged is no longer declared, so it
     would fail the "unlisted files" rule if left in the bundle. */
  fs.rmSync(path.join(f.bundle, 'notices/fixture-source.txt'))
  f.manifest.files = f.manifest.files.filter(entry => entry.path !== 'notices/fixture-source.txt')
  f.seal()
  return declared
}

test('a complete bundle with all eight redistribution assets still packs', async t => {
  const f = fixture(t)
  withAllRedistributionAssets(f)

  await beforePack({ electronPlatformName: 'win32', packager: { projectDir: f.root } })
})

test('a bundle missing the LAST of the eight pinned assets is refused by name', async t => {
  const f = fixture(t)
  withAllRedistributionAssets(f)
  const last = REDISTRIBUTION_ASSETS[REDISTRIBUTION_ASSETS.length - 1]

  /* Corrupt the eighth, not the first: a rule that only inspected files[0] would
     survive corrupting the first and is caught here. */
  f.write(`notices/${last}`, 'not the pinned bytes'); f.seal()

  await assert.rejects(
    beforePack({ electronPlatformName: 'win32', packager: { projectDir: f.root } }),
    new RegExp(`pinned notice/source: ${last.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    'a bundle whose eighth pinned asset was wrong was allowed into the build',
  )
})

/* THE PACKED COPY, WHICH IS THE LAST POINT THE SHIPPED BYTES ARE INSPECTED.
 *
 * The after-pack hook ran verifyVoiceBundle unconditionally and died with a raw
 * `ENOENT ... lstat release\win-unpacked\resources\voice-runtime\bundle` on the
 * first installer built without speech -- an fs stack trace where a sentence
 * belonged. Absence is now a stated outcome; presence is still fully verified,
 * including the pinned notices and the GPL corresponding source. */
test('the packed-bundle check accepts an installer without speech and still verifies one with it', async t => {
  const { verifyPackedVoiceBundle } = await import('../after-pack-strip-litter.cjs')
  const f = fixture(t)
  const said = []
  const log = line => said.push(line)

  // No packed bundle: the approved default, stated rather than thrown.
  const emptyOut = path.join(f.root, 'packed-without-speech')
  fs.mkdirSync(path.join(emptyOut, 'resources'), { recursive: true })
  assert.equal(await verifyPackedVoiceBundle(emptyOut, { log }), null)
  assert.match(said.join('\n'), /ships without it and the pack is the separate opt-in download/)

  // A packed bundle that IS present is verified, and a bad notice still refuses.
  const packedOut = path.join(f.root, 'packed-with-speech')
  fs.mkdirSync(path.join(packedOut, 'resources'), { recursive: true })
  fs.cpSync(f.source, path.join(packedOut, 'resources', 'voice-runtime'), { recursive: true })
  assert.ok(await verifyPackedVoiceBundle(packedOut, { log }), 'a valid packed bundle was not verified')

  /* notices/ lives INSIDE the bundle, not beside it -- the manifest lists them as
     `notices/<path>`. Writing to the source root instead produced an ENOENT that
     looked like a gate failure and was a fixture mistake. */
  fs.writeFileSync(path.join(packedOut, 'resources', 'voice-runtime', 'bundle', 'notices', 'fixture-source.txt'), 'wrong source')
  await assert.rejects(
    verifyPackedVoiceBundle(packedOut, { log }),
    /integrity failed|pinned notice\/source/,
    'a packed bundle with a bad pinned notice was accepted',
  )
})

/* THE LICENCE GATE, THROUGH THE HOOK. This is the assertion that keeps a partial
   bundle out: espeak-ng is GPL-3.0, and its corresponding source and licence text
   are pinned in redistribution-assets.json. A bundle missing one of them is not a
   smaller bundle, it is an unshippable one. */
test('a bundle missing its pinned notice or GPL source is refused by the builder hook', async t => {
  const f = fixture(t)
  f.write('notices/fixture-source.txt', 'wrong source'); f.seal()
  await assert.rejects(
    beforePack({ electronPlatformName: 'win32', packager: { projectDir: f.root } }),
    /pinned notice\/source/,
    'a bundle whose pinned notice/source does not match was allowed into the build',
  )
})
