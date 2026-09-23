import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Resolve the actual account, not a historical fixture or inherited profile.
// On Windows reject foreign temp paths lexically before inspecting any path.
// This is a test-input guard, not installed-product qualification evidence.
export function ownedFixtureTempRoot({
  platform = process.platform,
  selected = os.tmpdir(),
  accountHome = os.userInfo().homedir,
  filesystem = fs,
} = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix
  if (typeof selected !== 'string' || !paths.isAbsolute(selected)) throw new Error('Fixture temp must be absolute')
  const root = paths.resolve(selected)
  if (platform === 'win32') {
    if (!/^[a-z]:\\/i.test(selected) || selected.slice(2).includes(':') || /[. ](?:\\|$)/.test(selected)) {
      throw new Error('Fixture temp must use an ordinary drive-qualified path')
    }
    if (!paths.isAbsolute(accountHome)) throw new Error('The OS account home must be absolute')
    const relative = paths.relative(accountHome, root)
    if (!relative || relative === '..' || relative.startsWith('..\\') || paths.isAbsolute(relative)) {
      throw new Error('Fixture temp must stay inside the current OS account before any filesystem access')
    }
  }
  let cursor = paths.parse(root).root
  for (const segment of paths.relative(cursor, root).split(paths.sep)) {
    cursor = paths.join(cursor, segment)
    const entry = filesystem.lstatSync(cursor)
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Fixture temp ancestors must be ordinary directories, not links')
  }
  const resolved = filesystem.realpathSync.native(root)
  const comparable = value => platform === 'win32' ? paths.normalize(value).toLowerCase() : value
  if (comparable(resolved) !== comparable(root)) throw new Error('Fixture temp must not resolve through a path alias')
  return root
}
