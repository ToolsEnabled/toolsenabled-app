import fs from 'node:fs'
import path from 'node:path'
import { ownedFixtureTempRoot } from './owned-fixture-temp.mjs'

const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
function inside(parent, target) {
  const relative = path.relative(parent, target)
  return relative === '' || (!relative.startsWith('..' + path.sep)
    && relative !== '..' && !path.isAbsolute(relative))
}

// One retained run directory, outside source/generation and any Git checkout.
// ownedFixtureTempRoot rejects foreign Windows account paths before inspection.
export function createT842RetainedFixtureRoot({ baseRoot, sourceRoots, strictEnvironment } = {}) {
  if (!Array.isArray(sourceRoots) || sourceRoots.length === 0
    || sourceRoots.some(root => typeof root !== 'string' || !path.isAbsolute(root))) {
    fail('T842_FIXTURE_SOURCE_REQUIRED', 'Absolute source roots are required before creating fixtures')
  }
  // Only the suite opts into the preloaded environment. Ordinary callers do
  // not consume ambient IMAGE_* values.
  let selected = baseRoot
  if (strictEnvironment?.TOOLSENABLED_TEST_STRICT === '1') {
    const env = strictEnvironment
    if (env.TOOLSENABLED_RETAIN_LIFECYCLE_FIXTURES !== '1'
      || env.TOOLSENABLED_TEST_RETAIN_FIXTURES !== '1'
      || !env.IMAGE_TEST_TEMP || !env.TMPDIR || !env.TEMP || !env.TMP) {
      fail('T842_STRICT_FIXTURE_REQUIRED', 'Strict image fixtures require the retained preload directory contract')
    }
    const leaf = ownedFixtureTempRoot({ selected: env.TMPDIR })
    const temp = ownedFixtureTempRoot({ selected: env.TEMP })
    const tmp = ownedFixtureTempRoot({ selected: env.TMP })
    const imageTemp = ownedFixtureTempRoot({ selected: env.IMAGE_TEST_TEMP })
    if (path.relative(leaf, temp) !== '' || path.relative(leaf, tmp) !== ''
      || path.relative(path.join(leaf, 'image-test-temp'), imageTemp) !== '') {
      fail('T842_STRICT_FIXTURE_MISMATCH', 'Image scratch must belong to the current retained preload directory')
    }
    if (env.TOOLSENABLED_TEST_FIXTURE_PARENT !== undefined) {
      const parent = ownedFixtureTempRoot({ selected: env.TOOLSENABLED_TEST_FIXTURE_PARENT })
      if (path.relative(parent, path.dirname(leaf)) !== '' || path.relative(parent, leaf) === '') {
        fail('T842_STRICT_FIXTURE_MISMATCH', 'The current preload directory must be a child of its retained parent')
      }
    }
    if (selected !== undefined && !inside(imageTemp, ownedFixtureTempRoot({ selected }))) {
      fail('T842_FIXTURE_OUTSIDE_STRICT_CHILD', 'Strict image fixtures must stay inside the current child scratch directory')
    }
    selected ??= imageTemp
  }
  const base = ownedFixtureTempRoot(selected === undefined ? {} : { selected })
  for (const source of sourceRoots) {
    if (inside(ownedFixtureTempRoot({ selected: source }), base)) {
      fail('T842_FIXTURE_ROOT_IN_SOURCE', 'Retained image fixtures must be outside source and generation directories')
    }
  }
  for (let cursor = base; ; cursor = path.dirname(cursor)) {
    let marker
    try { marker = fs.lstatSync(path.join(cursor, '.git')) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (marker) fail('T842_FIXTURE_ROOT_IN_CHECKOUT', 'Retained image fixtures must be outside Git checkouts')
    if (path.dirname(cursor) === cursor) break
  }
  // Never reuse or clean another run's directory.
  return fs.mkdtempSync(path.join(base, 'te-t842-retained-'))
}
