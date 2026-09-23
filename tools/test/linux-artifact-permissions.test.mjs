import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'

const afterPack = createRequire(import.meta.url)('../after-pack-strip-litter.cjs')
const { normalizeLinuxArtifactPermissions } = afterPack
const linux = process.platform === 'linux' && process.getuid() !== 0
async function fixture(run) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-artifact-mode-'))
  const root = path.join(project, 'release', 'linux-unpacked')
  fs.mkdirSync(path.join(root, 'resources', 'capability'), { recursive: true })
  fs.writeFileSync(path.join(root, 'toolsenabled'), 'fake test binary')
  fs.chmodSync(path.join(root, 'toolsenabled'), 0o775)
  fs.writeFileSync(path.join(root, 'resources', 'app.asar'), 'fake test archive')
  fs.chmodSync(path.join(root, 'resources', 'app.asar'), 0o664)
  fs.writeFileSync(path.join(root, 'resources', 'capability', 'PAYLOAD.json'), '{}')
  for (const dir of [root, path.join(root, 'resources'), path.join(root, 'resources', 'capability')]) fs.chmodSync(dir, 0o775)
  const context = { electronPlatformName: 'linux', appOutDir: root, targets: [],
    packager: { projectDir: project, executableName: 'toolsenabled', appInfo: { productFilename: 'ToolsEnabled' } } }
  try { return await run({ project, root, context }) } finally { fs.rmSync(project, { recursive: true, force: true }) }
}
test('Linux normal packaging removes writable-by-other bits, preserves executable/content, and is idempotent', { skip: !linux }, () => fixture(({ root, context }) => {
  const executable = path.join(root, 'toolsenabled'), asar = path.join(root, 'resources', 'app.asar')
  const before = fs.readFileSync(executable)
  assert.ok(normalizeLinuxArtifactPermissions(context).changed >= 5)
  assert.equal(fs.statSync(executable).mode & 0o7777, 0o755)
  assert.equal(fs.statSync(asar).mode & 0o7777, 0o644)
  assert.equal(fs.statSync(root).mode & 0o7777, 0o755)
  assert.deepEqual(fs.readFileSync(executable), before)
  assert.equal(normalizeLinuxArtifactPermissions(context).changed, 0)
}))
test('Windows packaging is untouched', () => assert.deepEqual(normalizeLinuxArtifactPermissions({ electronPlatformName: 'win32' }), { skipped: true, changed: 0 }))
test('root/project scope and absent artifact markers refuse', { skip: !linux }, () => fixture(({ project, root, context }) => {
  assert.throws(() => normalizeLinuxArtifactPermissions({ ...context, appOutDir: project }))
  fs.unlinkSync(path.join(root, 'resources', 'capability', 'PAYLOAD.json'))
  assert.throws(() => normalizeLinuxArtifactPermissions(context))
  assert.equal(fs.statSync(root).mode & 0o777, 0o775)
}))
test('symlink into owner/source data refuses before any chmod', { skip: !linux }, () => fixture(({ project, root, context }) => {
  const outside = path.join(project, 'outside')
  fs.writeFileSync(outside, 'not an artifact'); fs.chmodSync(outside, 0o666)
  fs.symlinkSync(outside, path.join(root, 'linked'))
  assert.throws(() => normalizeLinuxArtifactPermissions(context))
  assert.equal(fs.statSync(outside).mode & 0o777, 0o666)
  assert.equal(fs.statSync(root).mode & 0o777, 0o775)
}))
test('hardlink into a shared dependency refuses without touching its mode', { skip: !linux }, () => fixture(({ project, root, context }) => {
  const outside = path.join(project, 'dependency')
  fs.writeFileSync(outside, 'shared'); fs.chmodSync(outside, 0o666)
  fs.linkSync(outside, path.join(root, 'hardlink'))
  assert.throws(() => normalizeLinuxArtifactPermissions(context))
  assert.equal(fs.statSync(outside).mode & 0o777, 0o666)
  assert.equal(fs.statSync(root).mode & 0o777, 0o775)
}))
test('unexpected setuid is refused, never normalized into approved privilege', { skip: !linux }, () => fixture(({ root, context }) => {
  const executable = path.join(root, 'toolsenabled')
  fs.chmodSync(executable, 0o4755)
  assert.throws(() => normalizeLinuxArtifactPermissions(context))
  assert.equal(fs.statSync(executable).mode & 0o7777, 0o4755)
}))
test('actual afterPack invokes normalization before attempting executable fuse changes', { skip: !linux }, () => fixture(async ({ root, context }) => {
  // Fake bytes deliberately cannot pass the normal fuse gate. Their mode must
  // already be narrowed by the actual hook before that later gate refuses.
  await assert.rejects(afterPack(context))
  assert.equal(fs.statSync(root).mode & 0o777, 0o755)
  assert.equal(fs.statSync(path.join(root, 'toolsenabled')).mode & 0o777, 0o755)
}))
