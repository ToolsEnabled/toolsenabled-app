import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { FuseV1Options, FuseVersion } = require('@electron/fuses')
const afterPack = require('../after-pack-strip-litter.cjs')

test('the packaged executable blocks ambient loader injection without disabling the capability runtime', () => {
  const policy = afterPack.PACKAGED_FUSE_POLICY
  assert.equal(policy.version, FuseVersion.V1)
  assert.equal(policy[FuseV1Options.RunAsNode], true,
    'the capability layer still needs the packaged executable as its Node runtime')
  assert.equal(policy[FuseV1Options.EnableNodeOptionsEnvironmentVariable], false,
    'NODE_OPTIONS can execute --require code before the startup identity guard')
  assert.equal(policy[FuseV1Options.EnableNodeCliInspectArguments], false,
    'the normal Electron-main path must reject Node inspector switches; RunAsNode argv is fenced separately')
  assert.equal(policy[FuseV1Options.OnlyLoadAppFromAsar], true,
    'packaged bytes must not fall back to an adjacent source app directory')
})

test('fuse hardening refuses an incomplete electron-builder context before touching a path', async () => {
  await assert.rejects(
    afterPack.hardenPackedElectron({ appOutDir: 'C:\\not-used' }),
    /no product filename/i,
  )
})

test('Linux and Windows packaging apply the same fuse policy to the actual executable', () => {
  const context = {
    appOutDir: path.resolve('unused-package-fixture'),
    packager: { appInfo: { productFilename: 'ToolsEnabled' }, executableName: 'toolsenabled' },
  }
  assert.equal(afterPack.packedExecutablePath({ ...context, electronPlatformName: 'linux' }),
    path.join(context.appOutDir, 'toolsenabled'))
  assert.equal(afterPack.packedExecutablePath({ ...context, electronPlatformName: 'win32' }),
    path.join(context.appOutDir, 'ToolsEnabled.exe'))
  assert.throws(() => afterPack.packedExecutablePath({ ...context, electronPlatformName: 'darwin' }), /unsupported packaging platform/)
  for (const executableName of [undefined, '', '.', '..', '../outside', 'dir/file', 'dir\\file', 'a\0b']) {
    assert.throws(() => afterPack.packedExecutablePath({
      ...context, electronPlatformName: 'linux', packager: { ...context.packager, executableName },
    }), /no safe Linux executable name/)
  }
})
