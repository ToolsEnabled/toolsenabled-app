import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
const { prepareLinuxDesktopIcons, prepareLinuxAppArmorProfile } = createRequire(import.meta.url)('../lib/linux-desktop-icons.cjs')
const linux = process.platform === 'linux' && process.getuid() !== 0
function fixture(t) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-icon-input-'))
  t.after(() => fs.rmSync(project, { recursive: true, force: true }))
  fs.mkdirSync(path.join(project, 'release'))
  const source = path.join(project, 'shared.png')
  fs.writeFileSync(source, 'synthetic-icon'); fs.chmodSync(source, 0o664)
  const icons = [{ file: source, size: 64 }]
  const helper = { icons: Promise.resolve(icons), maxIconPath: source }
  const context = { electronPlatformName: 'linux', appOutDir: path.join(project, 'release/linux-unpacked'), packager: { projectDir: project }, targets: [{ name: 'deb', helper }] }
  return { project, source, icons, helper, context }
}
function policyFixture(t) {
  const f = fixture(t)
  const policy = fs.readFileSync(new URL('../../build/linux/toolsenabled-customer.apparmor', import.meta.url))
  fs.mkdirSync(path.join(f.project, 'build/linux'), { recursive: true })
  fs.writeFileSync(path.join(f.project, 'build/linux/toolsenabled-customer.apparmor'), policy)
  const source = path.join(f.project, 'generated-apparmor-profile')
  fs.writeFileSync(source, policy); fs.chmodSync(source, 0o664)
  const scripts = { appArmor: source }
  f.context.targets[0].scriptFiles = Promise.resolve(scripts)
  return { ...f, policySource: source, policy, scripts }
}
test('FPM packages the fixed AppArmor policy as 0644 without chmodding its generated input', { skip: !linux }, async t => {
  const f = policyFixture(t)
  assert.deepEqual(await prepareLinuxAppArmorProfile(f.context), { copied: 1 })
  assert.notEqual(f.scripts.appArmor, f.policySource)
  assert.equal(fs.statSync(f.policySource).mode & 0o777, 0o664)
  assert.equal(fs.statSync(f.scripts.appArmor).mode & 0o777, 0o644)
  assert.equal(fs.statSync(path.dirname(f.scripts.appArmor)).mode & 0o777, 0o700)
  assert.deepEqual(fs.readFileSync(f.scripts.appArmor), f.policy)
})
test('linked or unexpected generated policy is refused before any FPM descriptor is changed', { skip: !linux }, async t => {
  const f = policyFixture(t)
  const linked = path.join(f.project, 'linked-policy')
  fs.symlinkSync(f.policySource, linked)
  f.scripts.appArmor = linked
  await assert.rejects(prepareLinuxAppArmorProfile(f.context))
  assert.equal(f.scripts.appArmor, linked)
  f.scripts.appArmor = f.policySource
  const bad = path.join(f.project, 'unexpected-policy')
  fs.writeFileSync(bad, 'unexpected policy')
  const second = { appArmor: bad }
  f.context.targets.push({ name: 'deb', scriptFiles: Promise.resolve(second) })
  await assert.rejects(prepareLinuxAppArmorProfile(f.context))
  assert.equal(f.scripts.appArmor, f.policySource)
  assert.equal(second.appArmor, bad)
})
test('AppArmor staging does not run for a Windows build', async () => {
  assert.deepEqual(await prepareLinuxAppArmorProfile({ electronPlatformName: 'win32' }), { copied: 0 })
})
test('FPM retained icon descriptors use private0644 copies; dependency bytes and modes remain untouched', { skip: !linux }, async t => {
  const f = fixture(t)
  assert.deepEqual(await prepareLinuxDesktopIcons(f.context), { copied: 1 })
  assert.notEqual(f.icons[0].file, f.source)
  assert.equal(fs.statSync(f.source).mode & 0o777, 0o664)
  assert.equal(fs.statSync(f.icons[0].file).mode & 0o777, 0o644)
  assert.deepEqual(fs.readFileSync(f.icons[0].file), fs.readFileSync(f.source))
  assert.equal(f.helper.maxIconPath, f.icons[0].file)
  assert.ok(f.icons[0].file.startsWith(path.join(f.project, 'release') + path.sep))
})
test('Windows icon staging is untouched', async () => {
  assert.deepEqual(await prepareLinuxDesktopIcons({ electronPlatformName: 'win32' }), { copied: 0 })
})
test('noncanonical output and parent replacement while icons resolve refuse', { skip: !linux }, async t => {
  const f = fixture(t)
  await assert.rejects(prepareLinuxDesktopIcons({ ...f.context, appOutDir: `${f.project}/release/../escape/linux-unpacked` }))
  f.helper.icons = { then(resolve) {
    fs.renameSync(path.join(f.project, 'release'), path.join(f.project, 'release-old'))
    fs.mkdirSync(path.join(f.project, 'release'))
    resolve(f.icons)
  } }
  await assert.rejects(prepareLinuxDesktopIcons(f.context))
  assert.equal(f.icons[0].file, f.source)
  assert.deepEqual(fs.readdirSync(path.join(f.project, 'release')), [])
})
test('missing helper or linked source refuses without changing descriptors', { skip: !linux }, async t => {
  const f = fixture(t)
  assert.deepEqual(await prepareLinuxDesktopIcons({ electronPlatformName: 'win32' }), { copied: 0 })
  await assert.rejects(prepareLinuxDesktopIcons({ ...f.context, targets: [{ name: 'deb' }] }))
  const linked = path.join(f.project, 'linked.png'); fs.symlinkSync(f.source, linked)
  f.icons[0].file = linked
  await assert.rejects(prepareLinuxDesktopIcons(f.context))
  assert.equal(f.icons[0].file, linked)
  assert.equal(fs.statSync(f.source).mode & 0o777, 0o664)
})
test('actual afterPack stages icons before fuse failure, never changes the shared source', { skip: !linux }, async t => {
  const f = policyFixture(t), out = f.context.appOutDir
  fs.mkdirSync(path.join(out, 'resources/capability'), { recursive: true })
  fs.writeFileSync(path.join(out, 'toolsenabled'), 'not-an-electron-binary')
  fs.writeFileSync(path.join(out, 'resources/app.asar'), 'fixture')
  fs.writeFileSync(path.join(out, 'resources/capability/PAYLOAD.json'), '{}')
  Object.assign(f.context.packager, { executableName: 'toolsenabled', appInfo: { productFilename: 'ToolsEnabled' } })
  const afterPack = createRequire(import.meta.url)('../after-pack-strip-litter.cjs')
  await assert.rejects(afterPack(f.context))
  assert.notEqual(f.icons[0].file, f.source)
  assert.equal(fs.statSync(f.icons[0].file).mode & 0o777, 0o644)
  assert.equal(fs.statSync(f.source).mode & 0o777, 0o664)
  assert.notEqual(f.scripts.appArmor, f.policySource)
  assert.equal(fs.statSync(f.scripts.appArmor).mode & 0o777, 0o644)
  assert.equal(fs.statSync(f.policySource).mode & 0o777, 0o664)
})
