import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { inspectSourceFixtureHome, retainedSourceFixtureEnvironment } from './lib/source-fixture-root.mjs'

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
const homes = [['linux', '/home/fixture-owner'], ['win32', 'C:\\Users\\fixture-owner']]

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
  const fs = filesystem('linux', { denied: '/home/.git' })
  assert.throws(() => inspectSourceFixtureHome('/home/fixture-owner', { platform: 'linux', filesystem: fs }), { code: 'EACCES' })
  for (const home of ['relative', '/', '/home/../other', '/home/bad\nname']) {
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
  for (const root of ['/other/te-source-fixture-Abc123', '/home/fixture-owner/nested/te-source-fixture-Abc123',
    '/home/fixture-owner/reused', '/home/fixture-owner/../te-source-fixture-Abc123']) {
    assert.throws(() => retainedSourceFixtureEnvironment(root, '/home/fixture-owner', 'linux'), /fresh direct child/)
  }
})
