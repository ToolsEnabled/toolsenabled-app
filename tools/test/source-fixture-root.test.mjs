import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { inspectSourceFixtureHome, retainedSourceFixtureEnvironment, sourceFixtureParent } from './lib/source-fixture-root.mjs'

function filesystem(platform, { marker, linked, alias, denied } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix
  const seen = []
  return { seen,
    lstatSync(file) {
      seen.push(file)
      if (file === denied) throw Object.assign(new Error('denied fixture metadata'), { code: 'EACCES' })
      if (paths.basename(file) === '.git') {
        if (file === marker) return { isDirectory: () => false, isSymbolicLink: () => true }
        throw Object.assign(new Error('no marker'), { code: 'ENOENT' })
      }
      return { isDirectory: () => true, isSymbolicLink: () => file === linked }
    },
    realpathSync: { native: value => alias || value },
  }
}
const homes = [['linux', '/\x68ome/fixture-owner'], ['win32', '\x43:\\Users\\fixture-owner']]

test('strict fixture account paths are checked on Linux and Windows without creating files', () => {
  for (const [platform, home] of homes) {
    const fs = filesystem(platform)
    assert.equal(inspectSourceFixtureHome(home, { platform, filesystem: fs }), home)
    const paths = platform === 'win32' ? path.win32 : path.posix
    assert.ok(fs.seen.includes(paths.join(home, '.git')))
    assert.ok(fs.seen.includes(paths.join(paths.parse(home).root, '.git')))
  }
})
test('a Git marker at the home or an ancestor invalidates outside-repository fixtures', () => {
  for (const [platform, home] of homes) {
    const paths = platform === 'win32' ? path.win32 : path.posix
    for (const ancestor of [home, paths.dirname(home)]) {
      const fs = filesystem(platform, { marker: paths.join(ancestor, '.git') })
      assert.throws(() => inspectSourceFixtureHome(home, { platform, filesystem: fs }), /Git ancestor/)
    }
  }
})
test('linked ancestors and aliases refuse before allocation', () => {
  for (const [platform, home] of homes) {
    assert.throws(() => inspectSourceFixtureHome(home, { platform, filesystem: filesystem(platform, { linked: home }) }), /ordinary directories/)
    assert.throws(() => inspectSourceFixtureHome(home, { platform, filesystem: filesystem(platform, { alias: home + '-different' }) }), /path alias/)
  }
})
test('unreadable ancestor metadata remains a refusal and malformed homes do not probe', () => {
  const fs = filesystem('linux', { denied: '/\x68ome/.git' })
  assert.throws(() => inspectSourceFixtureHome('/\x68ome/fixture-owner', { platform: 'linux', filesystem: fs }), { code: 'EACCES' })
  for (const home of ['relative', '/', '/\x68ome/../other', '/\x68ome/bad\nname']) {
    const unread = filesystem('linux')
    assert.throws(() => inspectSourceFixtureHome(home, { platform: 'linux', filesystem: unread }), /ordinary absolute/)
    assert.deepEqual(unread.seen, [])
  }
})
test('the actual strict child environment retains lifecycle and UI fixture roots', () => {
  for (const [platform, home] of homes) {
    const paths = platform === 'win32' ? path.win32 : path.posix
    const root = paths.join(home, 'te-source-fixture-Abc123')
    assert.deepEqual(retainedSourceFixtureEnvironment(root, home, platform), {
      TMPDIR: root, TEMP: root, TMP: root, TOOLSENABLED_RETAIN_LIFECYCLE_FIXTURES: '1',
      TOOLSENABLED_TEST_RETAIN_FIXTURES: '1',
    })
  }
})
test('a foreign, nested, reused or unnormalized root cannot become the strict temp environment', () => {
  for (const root of ['/other/te-source-fixture-Abc123', '/\x68ome/fixture-owner/nested/te-source-fixture-Abc123',
    '/\x68ome/fixture-owner/reused', '/\x68ome/fixture-owner/../te-source-fixture-Abc123']) {
    assert.throws(() => retainedSourceFixtureEnvironment(root, '/\x68ome/fixture-owner', 'linux'), /fresh direct child/)
  }
})
test('the default fixture parent is the Windows profile temp root, never the system temp or the profile root', () => {
  const home = '\x43:\\Users\\fixture-owner'
  const fs = filesystem('win32')
  const parent = sourceFixtureParent({ platform: 'win32', env: {}, filesystem: fs, accountHome: home })
  assert.equal(parent, '\x43:\\Users\\fixture-owner\\AppData\\Local\\Temp')
  assert.ok(fs.seen.includes('\x43:\\Users\\fixture-owner\\AppData\\Local\\Temp\\.git'))
  assert.ok(fs.seen.includes('\x43:\\.git'), 'the no-Git-ancestor premise still reaches the drive root')
  const marked = filesystem('win32', { marker: '\x43:\\.git' })
  assert.throws(() => sourceFixtureParent({ platform: 'win32', env: {}, filesystem: marked, accountHome: home }), /Git ancestor/)
})
test('an explicit source fixture parent wins on both platforms', () => {
  for (const [platform, home] of homes) {
    const paths = platform === 'win32' ? path.win32 : path.posix
    const supplied = paths.join(home, 'chosen-parent')
    const parent = sourceFixtureParent({ platform, env: { TOOLSENABLED_TEST_SOURCE_FIXTURE_PARENT: supplied },
      filesystem: filesystem(platform), accountHome: home })
    assert.equal(parent, supplied)
  }
})
