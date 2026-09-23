// The operator's purchase list is not part of the product.
//
// WHAT SHIPPED, AND WAS READ OFF THE PACKAGED WINDOW. public/data/purchase-catalog.json
// is the operator's own shopping list for launching this product -- 37 items, internal
// repo paths, internal request ids, second-person deliberations addressed to him, and a
// written admission that the installer is unsigned. vite copies public/** into dist/,
// package.json build.files ships "dist/**", and #/checkout was an unconditional stop on
// the navigation ring. So every installer carried it and one click back from home opened
// it on a stranger's fresh install.
//
// The defect class is this project's recurring one: absence read as consent. Nothing in
// the renderer half ever asked whose a file was, so a file nobody classified shipped.
// config/renderer-payload-boundary.json is where that question is now answered and
// tools/check-renderer-payload.mjs is what fails the build when it is not.
//
// WHAT THIS SUITE IS FOR, AND WHAT IT IS NOT. It is the fast half: the payload boundary
// in bytes, and the fail-closed rule the router hangs the surface on. It cannot see
// reachability -- whether a person can get to the screen is a property of the packaged
// window, and tools/checkout-privacy-packaged-qa.mjs is what asserts that, by clicking.
// Neither half is sufficient alone: the source half would pass on a build where the
// route was still live, and the window half would pass on a build that still carried the
// bytes but hid the door.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, openSync, readSync, closeSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  __setCheckoutSurfaceForTest,
  checkoutSurfaceAvailable,
  checkoutSurfaceSettled,
  CHECKOUT_SURFACE_INDETERMINATE,
  probeCheckoutSurface,
} from '../../src/checkout-visibility.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PUBLIC_ROOT = path.join(REPO_ROOT, 'public')
const DIST_ROOT = path.join(REPO_ROOT, 'dist')
const PACKAGED_ASAR = path.join(REPO_ROOT, 'release', 'win-unpacked', 'resources', 'app.asar')

/* Strings read off the packaged window on 2026-08-11, before the fix. Each one is a
   different kind of leak, and they are listed separately so a failure names which. */
const LEAK_MARKERS = Object.freeze([
  'config/toolsenabled.policy.json',   // an internal file path, rendered on screen
  'src/lib/providers/pay.js',          // an internal module path, rendered on screen
  'More info then Run anyway',         // the admission that the installer is unsigned
  'R1203',                             // an internal request id
  'You asked the price directly',      // the operator addressed in the second person
])

function filesUnder(root) {
  const found = []
  const walk = (directory, relative) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const next = path.join(directory, entry.name)
      const rel = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) walk(next, rel)
      else if (entry.isFile()) found.push({ relative: rel, absolute: next })
    }
  }
  if (existsSync(root)) walk(root, '')
  return found
}

const TEXTUAL = /\.(js|mjs|cjs|json|html|css|md|txt|svg)$/i

function scanForMarkers(files) {
  const hits = []
  for (const file of files) {
    if (!TEXTUAL.test(file.relative)) continue
    const body = readFileSync(file.absolute, 'utf8')
    for (const marker of LEAK_MARKERS) {
      if (body.includes(marker)) hits.push(`${file.relative} carries ${JSON.stringify(marker)}`)
    }
  }
  return hits
}

/* ---------- the payload, in bytes ---------- */

test('the authored payload carries no purchase list', () => {
  const staged = filesUnder(PUBLIC_ROOT).map(file => file.relative)
  assert.ok(staged.length > 0, 'public/ is empty, so this assertion checked nothing')
  assert.ok(
    !staged.includes('data/purchase-catalog.json'),
    'public/data/purchase-catalog.json is back. vite copies public/** into dist/ verbatim, so it would '
    + 'ship in app.asar again. The operator\'s list belongs in private/purchase-catalog.owner.json and is '
    + 'read at runtime from the install\'s own data directory.',
  )
})

test('nothing authored for the payload carries the operator\'s own words', () => {
  const hits = scanForMarkers(filesUnder(PUBLIC_ROOT))
  assert.deepEqual(hits, [], `public/ carries operator data:\n  ${hits.join('\n  ')}`)
})

test('the built payload carries no purchase list and none of its words', (t) => {
  const built = filesUnder(DIST_ROOT)
  if (built.length === 0) return t.skip('no dist/ on this machine; run `npm run build` to include it')
  assert.ok(
    !built.some(file => file.relative === 'data/purchase-catalog.json'),
    'dist/data/purchase-catalog.json exists and electron-builder packs dist/** into app.asar',
  )
  const hits = scanForMarkers(built)
  assert.deepEqual(hits, [], `dist/ carries operator data:\n  ${hits.join('\n  ')}`)
})

/* THE ARTIFACT ON DISK IS ONLY EVIDENCE ABOUT THIS TREE IF IT WAS BUILT FROM IT.
 *
 * release/win-unpacked is whatever `npm run dist` last produced, which on a shared
 * checkout can be hours and several lanes old. Asserting against an older archive would
 * report a defect that has already been fixed, or -- far worse the other way round --
 * clear a build nobody has made yet. So this test refuses to report on an archive that
 * predates dist/, by name, and the unconditional version of the same assertion lives in
 * the two places where the artifact is guaranteed current: `npm run dist` and
 * `npm run release:cut` both run tools/check-renderer-payload.mjs against it. */
function archivePredatesBuild() {
  if (!existsSync(DIST_ROOT)) return false
  const archiveTime = statSync(PACKAGED_ASAR).mtimeMs
  const newestBuilt = filesUnder(DIST_ROOT).reduce((newest, file) => Math.max(newest, statSync(file.absolute).mtimeMs), 0)
  return archiveTime < newestBuilt
}

test('the packaged archive a stranger downloads carries neither', (t) => {
  if (!existsSync(PACKAGED_ASAR)) return t.skip('no packaged build on this machine; run `npm run dist` to include it')
  if (archivePredatesBuild()) {
    return t.skip(
      `${path.relative(REPO_ROOT, PACKAGED_ASAR)} is older than dist/, so it is not a build of this tree and `
      + 'this test would be reporting on the wrong bytes. Re-measure with `npm run dist` (which gates on '
      + 'tools/check-renderer-payload.mjs) or with tools/checkout-privacy-packaged-qa.mjs, which repacks the '
      + 'current tree into a real archive and drives the window.',
    )
  }
  const { entries, headerCount, baseOffset } = readArchive(PACKAGED_ASAR)
  // A reader that stopped early cannot clear a payload, and this project has already
  // had one false root cause from a listing that truncated itself in silence.
  assert.equal(entries.length, headerCount, 'the archive walk disagrees with the archive header; its verdict means nothing')

  const catalogues = entries.filter(entry => /purchase-catalog\.json$/.test(entry.path) && !entry.path.includes('schema'))
  assert.deepEqual(catalogues.map(entry => entry.path), [], 'the installer carries a purchase list')

  const hits = []
  for (const entry of entries) {
    if (!TEXTUAL.test(entry.path)) continue
    const body = readEntry(PACKAGED_ASAR, entry, baseOffset)
    for (const marker of LEAK_MARKERS) {
      if (body.includes(marker)) hits.push(`${entry.path} carries ${JSON.stringify(marker)}`)
    }
  }
  assert.deepEqual(hits, [], `the installer carries operator data:\n  ${hits.join('\n  ')}`)
})

test('the renderer payload boundary guard passes on this tree', () => {
  // Runs the guard itself rather than restating its rules: a second copy of a rule is a
  // copy that drifts, and the guard is what `npm run dist` actually gates on.
  const output = execFileSync(process.execPath, [path.join(REPO_ROOT, 'tools', 'check-renderer-payload.mjs')], {
    cwd: REPO_ROOT, encoding: 'utf8',
  })
  assert.match(output, /check-renderer-payload: OK/)
})

/* ---------- the surface fails closed ---------- */

test('the checkout surface is unavailable before anything has been measured', () => {
  __setCheckoutSurfaceForTest(false, false)
  assert.equal(checkoutSurfaceAvailable(), false)
  assert.equal(checkoutSurfaceSettled(), false, 'not measured yet is not the same answer as no')
})

test('a served catalogue is the only thing that turns the surface on', async () => {
  __setCheckoutSurfaceForTest(false, false)
  const available = await probeCheckoutSurface({
    fetchImpl: async () => ({ ok: true, headers: { get: () => 'application/json; charset=utf-8' } }),
    dispatch: null,
    hosted: () => true,
  })
  assert.equal(available, true)
  assert.equal(checkoutSurfaceAvailable(), true)
  assert.equal(checkoutSurfaceSettled(), true)
})

test('only a 404 becomes cached absence; machine failures remain indeterminate', async () => {
  __setCheckoutSurfaceForTest(true, false)
  const absent = await probeCheckoutSurface({
    fetchImpl: async () => ({ ok: false, status: 404, headers: { get: () => 'application/json' } }),
    dispatch: null,
    hosted: () => true,
  })
  assert.equal(absent, false, 'CONTROL: a real 404 remains unavailable')
  assert.equal(checkoutSurfaceAvailable(), false, 'CONTROL: real absence replaces the cached value')
  assert.equal(checkoutSurfaceSettled(), true, 'CONTROL: real absence remains cached as settled')

  for (const [why, failure] of [
    ['EMFILE', Object.assign(new Error('descriptor table busy'), { code: 'EMFILE' })],
    ['EAGAIN', Object.assign(new Error('try again'), { code: 'EAGAIN' })],
    ['EIO', Object.assign(new Error('temporary I/O failure'), { code: 'EIO' })],
    ['EBUSY', Object.assign(new Error('device busy'), { code: 'EBUSY' })],
    ['a non-Error throw with no code', 'bridge unavailable'],
  ]) {
    __setCheckoutSurfaceForTest(true, false)
    const answer = await probeCheckoutSurface({
      fetchImpl: async () => { throw failure },
      dispatch: null,
      hosted: () => true,
    })
    assert.equal(answer.code, CHECKOUT_SURFACE_INDETERMINATE, `${why} must have the could-not-tell code`)
    assert.match(answer.message, /NOT claiming .* absent/, `${why} must disclaim absence`)
    assert.equal(checkoutSurfaceAvailable(), true, `${why} must not replace the cached availability`)
    assert.equal(checkoutSurfaceSettled(), false, `${why} must not latch the probe as settled`)
  }
})

test('a probe that never answers is indeterminate and is not cached', async () => {
  __setCheckoutSurfaceForTest(true, false)
  const answer = await probeCheckoutSurface({
    fetchImpl: () => new Promise(() => {}),
    timeoutMs: 30,
    dispatch: null,
    hosted: () => true,
  })
  assert.equal(answer.code, CHECKOUT_SURFACE_INDETERMINATE)
  assert.match(answer.message, /NOT claiming .* absent/)
  assert.equal(checkoutSurfaceAvailable(), true)
  assert.equal(checkoutSurfaceSettled(), false, 'a timeout must preserve rather than latch prior unsettled state')
})

/* ---------- the probe is only made on a copy the desktop shell hosts ---------- */

/* MEASURED ON toolsenabled.ai/app/: every page load asked the website for
   data/purchase-catalog.json and was answered 404. The surface was off, but by
   accident of the 404, and the site saw a request for a file it has never held.
   The discriminator is onDesktop() from src/data-source.js -- the preload's
   getBridgeProof, which the site's host bridge withholds on purpose -- and the
   test spells each window shape out because "site-shaped" is the one that used
   to fool nothing and now has to be refused by decision rather than by luck. */

function servedCatalogue() {
  const calls = []
  const fetchImpl = async (...args) => {
    calls.push(args)
    return { ok: true, headers: { get: () => 'application/json; charset=utf-8' } }
  }
  return { calls, fetchImpl }
}

async function withWindow(shape, run) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window')
  const before = globalThis.window
  if (shape === undefined) delete globalThis.window
  else globalThis.window = shape
  try {
    return await run()
  } finally {
    if (had) globalThis.window = before
    else delete globalThis.window
  }
}

test('a copy with no window at all is never asked for a list', async () => {
  await withWindow(undefined, async () => {
    __setCheckoutSurfaceForTest(true, false)
    const { calls, fetchImpl } = servedCatalogue()
    const available = await probeCheckoutSurface({ fetchImpl, dispatch: null })
    assert.equal(calls.length, 0, 'the probe fetched on a copy nothing hosts')
    assert.equal(available, false)
    assert.equal(checkoutSurfaceAvailable(), false)
    assert.equal(checkoutSurfaceSettled(), true, 'a skipped probe must settle exactly like a failed one')
  })
})

test('the public origin -- a site-shaped window with an endpoint but no proof -- is never asked', async () => {
  // The website's host bridge defines mcShell too (endpoint + relay transport);
  // what it deliberately lacks is getBridgeProof. That absence is the decision.
  const siteShaped = { mcShell: { getBridgeEndpoint: () => 'http://127.0.0.1:0' } }
  await withWindow(siteShaped, async () => {
    __setCheckoutSurfaceForTest(true, false)
    const { calls, fetchImpl } = servedCatalogue()
    const available = await probeCheckoutSurface({ fetchImpl, dispatch: null })
    assert.equal(calls.length, 0, 'the probe asked the public origin for data/purchase-catalog.json')
    assert.equal(available, false)
    assert.equal(checkoutSurfaceAvailable(), false)
    assert.equal(checkoutSurfaceSettled(), true)
  })
})

test('a desktop-shaped window is asked, and a served list turns the surface on', async () => {
  const desktopShaped = { mcShell: { getBridgeEndpoint: () => 'http://127.0.0.1:0', getBridgeProof: () => 'proof' } }
  await withWindow(desktopShaped, async () => {
    __setCheckoutSurfaceForTest(false, false)
    const { calls, fetchImpl } = servedCatalogue()
    const available = await probeCheckoutSurface({ fetchImpl, dispatch: null })
    assert.equal(calls.length, 1, 'the desktop copy was not asked')
    assert.equal(available, true)
    assert.equal(checkoutSurfaceAvailable(), true)
    assert.equal(checkoutSurfaceSettled(), true)
  })
})

test('a hosting discriminator that throws or answers oddly is treated as not hosted', async () => {
  for (const [why, hosted] of [
    ['throws', () => { throw new Error('no shell') }],
    ['answers a truthy non-boolean', () => 1],
    ['is not a function', 'yes'],
  ]) {
    __setCheckoutSurfaceForTest(true, false)
    const { calls, fetchImpl } = servedCatalogue()
    const available = await probeCheckoutSurface({ fetchImpl, dispatch: null, hosted })
    assert.equal(calls.length, 0, `the probe fetched when the discriminator ${why}`)
    assert.equal(available, false, `the surface survived a discriminator that ${why}`)
    assert.equal(checkoutSurfaceSettled(), true)
  }
})

test('the visibility module introduces no dependency beyond the desktop data source', () => {
  // This is deliberately static: behavior cannot reveal an import that creates
  // a cycle or needlessly pulls another module into the renderer graph. Which
  // local name the implementation gives the discriminator is not part of that
  // rule; the window-shape tests above exercise the default discriminator.
  const source = readFileSync(path.join(REPO_ROOT, 'src', 'checkout-visibility.js'), 'utf8')
  const imports = [...source.matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)].map(match => match[1])
  assert.deepEqual(
    imports,
    ['./data-source.js'],
    'checkout visibility must not add another module to the renderer dependency graph',
  )
})

/* ---------- asar reading, same format as tools/check-asar-manifest.mjs ---------- */

function readArchive(archivePath) {
  const fd = openSync(archivePath, 'r')
  try {
    const head = Buffer.alloc(16)
    readSync(fd, head, 0, 16, 0)
    const jsonLength = head.readUInt32LE(12)
    const jsonBuffer = Buffer.alloc(jsonLength)
    readSync(fd, jsonBuffer, 0, jsonLength, 16)
    const header = JSON.parse(jsonBuffer.toString('utf8'))
    const entries = []
    const walk = (node, prefix) => {
      for (const [name, child] of Object.entries(node.files || {})) {
        const full = prefix ? `${prefix}/${name}` : name
        if (child.files) walk(child, full)
        else entries.push({ path: full, size: child.size, offset: Number(child.offset) })
      }
    }
    walk(header, '')
    const count = (node) => Object.values(node.files || {})
      .reduce((total, child) => total + (child.files ? count(child) : 1), 0)
    return { entries, headerCount: count(header), baseOffset: 16 + Math.ceil(jsonLength / 4) * 4 }
  } finally {
    closeSync(fd)
  }
}

function readEntry(archivePath, entry, baseOffset) {
  const fd = openSync(archivePath, 'r')
  try {
    const buffer = Buffer.alloc(entry.size)
    if (entry.size > 0) readSync(fd, buffer, 0, entry.size, baseOffset + entry.offset)
    return buffer.toString('utf8')
  } finally {
    closeSync(fd)
  }
}
