/*
 * download-wire.test.mjs — R1260 T5.1
 *
 * Behavioural tests for tools/check-download-wire.mjs.
 *
 * The guard is run as a REAL SUBPROCESS against REAL fixture directories on
 * disk. Nothing about the subject is mocked, so a pass here means the shipped
 * CLI refused, not that a stub returned a value.
 *
 * ABSENCE BEFORE PRESENCE: the first and largest block asserts what the guard
 * REFUSES. This codebase's recurring defect is absence read as consent -- a
 * missing field, an empty string, a falsy default that turns "nothing
 * specified" into "allowed". A missing declaration field is therefore tested
 * once per field, and separately for the empty-string case, because those are
 * two different ways to say nothing and a guard can catch one and miss the other.
 *
 * Mutation proof (2026-08-28): inverting the offer/name comparison made four
 * assertions fail, including both refusal and allow-path coverage below.
 *
 * Every refusal assertion checks the MESSAGE NAMES THE DEFECT, not merely that
 * the exit code was 1. A guard that exits 1 for the wrong reason is not a kill.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { readExeVersionInfo, releaseVersionFromPe } = require('../../shell/installer-pe-identity.cjs')

const GUARD = resolve(import.meta.dirname, '..', 'check-download-wire.mjs')

function run(args) {
  const r = spawnSync(process.execPath, [GUARD, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  })
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

function scratch() {
  return mkdtempSync(join(tmpdir(), 'dlwire-'))
}

/* A minimally realistic built site. `withLink` controls whether it offers an
 * installer, which is the thing a declaration has to justify. */
function makeDist(root, { withLink = false, withBlobExport = false } = {}) {
  const dist = join(root, 'dist')
  mkdirSync(join(dist, 'assets'), { recursive: true })
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>ToolsEnabled</title><body></body>')
  let js = 'const x=1;'
  if (withLink) js += 'const a=`<a href="/downloads/ToolsEnabled Setup 1.0.6.exe">Download</a>`;'
  if (withBlobExport) js += 'function e(s,t){const a=document.createElement("a");a.href=s;a.download=t;a.click()}'
  writeFileSync(join(dist, 'assets', 'index-abc.js'), js)
  return dist
}

const VALID = {
  filename: 'ToolsEnabled Setup 1.0.6.exe',
  version: '1.0.6',
  bytes: 11,
  sha256: createHash('sha256').update(Buffer.from('hello world')).digest('hex'),
  productName: 'ToolsEnabled',
  fileVersion: '1.0.6',
  productVersion: '1.0.6',
  buildRef: 'a'.repeat(40),
  publisher: 'ToolsEnabled, Inc. in formation',
  appId: 'com.toolsenabled.desktop',
  immutableLocation: 'C:\\Users\\x\\Desktop\\frozen-candidate',
}

// Only the two positive PE-resource controls need native Windows. Loading
// PE metadata at module scope on Linux used to prevent every independent
// declaration/refusal case below from executing at all.
const NATIVE_PE_TEST = { skip: process.platform === 'win32' ? false : 'Native Windows PE resource proof: must execute on Windows before publication' }
const NODE_PE = process.platform === 'win32' ? await readExeVersionInfo(process.execPath) : null
const NODE_PE_VERSION = NODE_PE ? releaseVersionFromPe(NODE_PE.productVersion) : null
const NODE_PE_BYTES = NODE_PE ? readFileSync(process.execPath) : null
const VALID_PE = NODE_PE ? {
  ...VALID,
  filename: `ToolsEnabled Setup ${NODE_PE_VERSION}.exe`,
  version: NODE_PE_VERSION,
  bytes: statSync(process.execPath).size,
  sha256: createHash('sha256').update(NODE_PE_BYTES).digest('hex'),
  productName: NODE_PE.productName,
  fileVersion: NODE_PE.fileVersion,
  productVersion: NODE_PE.productVersion,
} : null

function writeManifest(dist, obj) {
  writeFileSync(join(dist, 'download.json'), JSON.stringify(obj, null, 2))
}

function makeCandidate(root, filename, content = 'hello world') {
  const dir = join(root, 'frozen')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, filename), content)
  return dir
}

function makePeCandidate(root, filename = VALID_PE.filename) {
  const dir = join(root, 'frozen')
  mkdirSync(dir, { recursive: true })
  copyFileSync(process.execPath, join(dir, filename))
  return dir
}

// ---------------------------------------------------------------------------
// ABSENCE CASES -- the guard must REFUSE
// ---------------------------------------------------------------------------

test('REFUSES a download offer that has no declaration at all', () => {
  const root = scratch()
  try {
    const dist = makeDist(root, { withLink: true })
    const r = run([dist])
    assert.equal(r.status, 1, 'a download link with no declaration must refuse')
    assert.match(r.out, /DOWNLOAD OFFER WITH NO DECLARATION/,
      'refusal must name the missing declaration, not fail generically')
    assert.match(r.out, /\.exe/, 'refusal must quote the offending link')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

for (const field of ['filename', 'version', 'bytes', 'sha256', 'productName', 'fileVersion', 'productVersion', 'buildRef', 'publisher', 'appId', 'immutableLocation']) {
  test(`REFUSES when required field "${field}" is ABSENT`, () => {
    const root = scratch()
    try {
      const dist = makeDist(root, { withLink: true })
      const m = { ...VALID }
      delete m[field]
      writeManifest(dist, m)
      const r = run([dist])
      assert.equal(r.status, 1, `a declaration missing ${field} must refuse`)
      assert.match(r.out, new RegExp(`MISSING FIELD "${field}"`),
        `refusal must name the absent field ${field}`)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test(`REFUSES when required field "${field}" is present but EMPTY`, () => {
    const root = scratch()
    try {
      const dist = makeDist(root, { withLink: true })
      // An empty STRING for a numeric field is still "nothing specified".
      writeManifest(dist, { ...VALID, [field]: field === 'bytes' ? 0 : '   ' })
      const r = run([dist])
      assert.equal(r.status, 1, `an empty ${field} must refuse, not pass as "specified"`)
      assert.match(r.out, new RegExp(`FIELD "${field}" INVALID`),
        `refusal must name the empty field ${field}`)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
}

test('REFUSES a byte count supplied as a STRING rather than an integer', () => {
  const root = scratch()
  try {
    const dist = makeDist(root, { withLink: true })
    writeManifest(dist, { ...VALID, bytes: '11' })
    const r = run([dist])
    assert.equal(r.status, 1)
    assert.match(r.out, /FIELD "bytes" INVALID/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('REFUSES an ABBREVIATED build ref -- 7 chars cannot identify a build', () => {
  const root = scratch()
  try {
    const dist = makeDist(root, { withLink: true })
    writeManifest(dist, { ...VALID, buildRef: 'a1b2c3d' })
    const r = run([dist])
    assert.equal(r.status, 1)
    assert.match(r.out, /FIELD "buildRef" INVALID/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('REFUSES a truncated sha256', () => {
  const root = scratch()
  try {
    const dist = makeDist(root, { withLink: true })
    writeManifest(dist, { ...VALID, sha256: 'deadbeef' })
    const r = run([dist])
    assert.equal(r.status, 1)
    assert.match(r.out, /FIELD "sha256" INVALID/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('REFUSES an immutableLocation that points into a build output directory', () => {
  const root = scratch()
  try {
    const dist = makeDist(root, { withLink: true })
    writeManifest(dist, { ...VALID, immutableLocation: 'C:\\Users\\x\\wt-capability\\release\\' })
    const r = run([dist])
    assert.equal(r.status, 1, 'a build directory reuses one filename per build; a hash quoted there expires silently')
    assert.match(r.out, /POINTS INTO A BUILD DIRECTORY/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('REFUSES when the declared sha256 does not match the real bytes', () => {
  const root = scratch()
  try {
    const dist = makeDist(root, { withLink: true })
    writeManifest(dist, { ...VALID, sha256: 'b'.repeat(64) })
    const cand = makeCandidate(root, VALID.filename)
    const r = run([dist, '--candidate-root', cand])
    assert.equal(r.status, 1)
    assert.match(r.out, /SHA-256 MISMATCH/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('REFUSES when the declared byte count does not match the real bytes', () => {
  const root = scratch()
  try {
    const dist = makeDist(root, { withLink: true })
    writeManifest(dist, { ...VALID, bytes: 999999 })
    const cand = makeCandidate(root, VALID.filename)
    const r = run([dist, '--candidate-root', cand])
    assert.equal(r.status, 1)
    assert.match(r.out, /BYTE COUNT MISMATCH/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('REFUSES when the declaration names a candidate that is not on disk', () => {
  const root = scratch()
  try {
    const dist = makeDist(root, { withLink: true })
    writeManifest(dist, VALID)
    const cand = makeCandidate(root, 'some-other-file.exe')
    const r = run([dist, '--candidate-root', cand])
    assert.equal(r.status, 1)
    assert.match(r.out, /DECLARED CANDIDATE NOT FOUND/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('REFUSES an unreadable (malformed) declaration rather than ignoring it', () => {
  const root = scratch()
  try {
    const dist = makeDist(root, { withLink: true })
    writeFileSync(join(dist, 'download.json'), '{ this is not json')
    const r = run([dist])
    assert.equal(r.status, 1, 'a corrupt declaration must refuse, never be silently skipped')
    assert.match(r.out, /DECLARATION UNREADABLE/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// VACUITY -- a scan that measured nothing must never report success
// ---------------------------------------------------------------------------

test('REFUSES SUCCESS when it scanned zero files', () => {
  const root = scratch()
  try {
    const empty = join(root, 'dist')
    mkdirSync(empty, { recursive: true })
    const r = run([empty])
    assert.equal(r.status, 1, 'an empty scan must not look like a clean result')
    assert.match(r.out, /REFUSING SUCCESS: scanned ZERO files/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('REFUSES a dist directory that does not exist', () => {
  const root = scratch()
  try {
    const r = run([join(root, 'nope')])
    assert.equal(r.status, 1)
    assert.match(r.out, /dist directory not found/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// PRESENCE -- the guard must PASS only for genuinely consistent states
// ---------------------------------------------------------------------------

test('PASSES the current real state: no declaration and no download offer', () => {
  const root = scratch()
  try {
    const dist = makeDist(root, { withLink: false })
    const r = run([dist])
    assert.equal(r.status, 0, 'offering no installer while no candidate is declared is correct')
    assert.match(r.out, /no declaration and no download offer/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('PASSES a complete declaration whose bytes verify', NATIVE_PE_TEST, () => {
  const root = scratch()
  try {
    const dist = makeDistOffering(root, `/downloads/${VALID_PE.filename}`)
    writeManifest(dist, VALID_PE)
    const cand = makePeCandidate(root)
    const r = run([dist, '--candidate-root', cand])
    assert.equal(r.status, 0, `expected pass, got:\n${r.out}`)
    assert.match(r.out, /backed by a complete, verified declaration/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('does NOT cry wolf at the blob-export idiom already in this bundle', () => {
  const root = scratch()
  try {
    // `a.download = filename` is how the app exports a JSON blob. It is not a
    // product download. A guard that flags it would be switched off by the
    // first person it annoyed, and then it would protect nothing.
    const dist = makeDist(root, { withLink: false, withBlobExport: true })
    const r = run([dist])
    assert.equal(r.status, 0, `blob export must not be read as an installer offer:\n${r.out}`)
    assert.match(r.out, /installer offers found: 0/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// R1260 t5b-xverify — RULE 4: THE OFFER MUST BE THE DECLARED FILE
//
// Found by adversarial probe: rules 2 and 3 prove the declaration is internally
// sound and that ITS OWN bytes verify, but nothing compared the file the PAGE
// OFFERS against the file the declaration DESCRIBES. A page offering any other
// .exe passed as long as some valid declaration existed in the bundle, so the
// declaration authorised a download it had never seen.
//
// This is the codebase's recurring defect in its purest form: the LINK between
// offer and declaration was ABSENT, and the absence was read as consent. It is
// latent today only because no declaration exists at all; it opens the moment
// the wire is finally connected, which is exactly when it matters.
// ---------------------------------------------------------------------------

/* A built site whose installer link is whatever the caller says, so the offer
 * and the declaration can be made to disagree. */
function makeDistOffering(root, href) {
  const dist = join(root, 'dist')
  mkdirSync(join(dist, 'assets'), { recursive: true })
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>ToolsEnabled</title><body></body>')
  writeFileSync(join(dist, 'assets', 'index-abc.js'),
    `const a=\`<a href="${href}">Download</a>\`;`)
  return dist
}

test('REFUSES a page that offers a file the declaration does NOT describe', () => {
  const root = scratch()
  try {
    // Declaration is complete and its bytes verify -- every other rule is happy.
    const dist = makeDistOffering(root, '/downloads/TotallyNotTheDeclaredFile.exe')
    writeManifest(dist, VALID)
    const cand = makeCandidate(root, VALID.filename)
    const r = run([dist, '--candidate-root', cand])
    assert.equal(r.status, 1, `a valid declaration must not authorise an undeclared file:\n${r.out}`)
    assert.match(r.out, /OFFER DOES NOT MATCH THE DECLARATION/)
    assert.match(r.out, /TotallyNotTheDeclaredFile\.exe/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('REFUSES an undeclared offer even when a SECOND, valid offer is also present', () => {
  const root = scratch()
  try {
    // The declared file IS offered -- but so is another one. Catching only the
    // first hit, or passing because "a" matching offer exists, would miss this.
    const dist = join(root, 'dist')
    mkdirSync(join(dist, 'assets'), { recursive: true })
    writeFileSync(join(dist, 'index.html'), '<!doctype html><body></body>')
    writeFileSync(join(dist, 'assets', 'index-abc.js'),
      `const a=\`<a href="/d/${VALID.filename}">Get</a>\`;` +
      `const b=\`<a href="/d/Backdoor Setup 9.9.9.exe">Also</a>\`;`)
    writeManifest(dist, VALID)
    const cand = makeCandidate(root, VALID.filename)
    const r = run([dist, '--candidate-root', cand])
    assert.equal(r.status, 1, `a second undeclared offer must still refuse:\n${r.out}`)
    assert.match(r.out, /OFFER DOES NOT MATCH THE DECLARATION/)
    assert.match(r.out, /Backdoor Setup 9\.9\.9\.exe/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('REFUSES an offer when the declaration filename is EMPTY (absence is not consent)', () => {
  const root = scratch()
  try {
    const dist = makeDistOffering(root, '/downloads/Anything.exe')
    writeManifest(dist, { ...VALID, filename: '   ' })
    const r = run([dist])
    assert.equal(r.status, 1, `an empty declared filename must never authorise an offer:\n${r.out}`)
    assert.match(r.out, /OFFER DOES NOT MATCH THE DECLARATION/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('does NOT cry wolf when the declared file is served from another directory or CDN', NATIVE_PE_TEST, () => {
  const root = scratch()
  try {
    // Same file, different prefix, plus a query string. This must PASS, or the
    // rule would forbid serving the installer from anywhere but the site root.
    const dist = makeDistOffering(root, `https://cdn.example.com/rel/v1/${VALID_PE.filename}?t=1`)
    writeManifest(dist, VALID_PE)
    const cand = makePeCandidate(root)
    const r = run([dist, '--candidate-root', cand])
    assert.equal(r.status, 0, `a matching file served from a CDN path must pass:\n${r.out}`)
    assert.match(r.out, /backed by a complete, verified declaration/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
