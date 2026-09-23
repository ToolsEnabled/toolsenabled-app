import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/* THE BUILD ROW ON THE WEBSITE SAID "recorded, but names no version". Measured
 * on the live site on 2026-08-22: the drawer fetched '/build-info.json', which
 * on the desktop is the application's own record but on the website is the
 * SITE's record (commit, shortCommit, channel -- no version). The vendored
 * application lives at /app/ and writes /app/build-info.json with appVersion
 * and shortCommit. So the fetch must be relative, and the reader must accept
 * both writers' shapes by name. This pins both, by source, the way the other
 * drawer tests in permission-guidance.test.mjs read the same file. */
const DRAWER = readFileSync(new URL('../../src/quick-settings.js', import.meta.url), 'utf8')
const ROW = DRAWER.slice(DRAWER.indexOf('async function fillBuildRow'), DRAWER.indexOf('function wire('))

test('the build row fetches its record relative to the application, not the origin root', () => {
  assert.match(ROW, /fetch\('build-info\.json'/, 'the fetch must be relative so /app/ on the website reaches its own record')
  assert.doesNotMatch(ROW, /fetch\('\/build-info\.json'/, 'a rooted fetch reads the website\'s record, which has no version')
})

test('the build row reads both writers\' shapes by name', () => {
  for (const field of ['info.version', 'info.appVersion', 'info.app?.ref', 'info.shortCommit', 'info.checkedAt']) {
    assert.ok(ROW.includes(field), `the reader no longer looks at ${field}`)
  }
  assert.match(ROW, /served from the website/, 'a web copy says where it is served from')
})
